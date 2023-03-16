import * as core from "@actions/core"
import * as github from "@actions/github"
import * as tc from "@actions/tool-cache"
import * as io from "@actions/io"
import * as path from "path"
import * as fs from "fs"
import * as tar from "tar"
import * as yaml from "js-yaml"
import * as async from "async"
import { CodeQL, CodeQLPack, CodeQLPackYmlSpec } from "./codeql"
import internal = require("stream")

export class Bundle {
    private octokit: any
    private tag: string
    private bundlePath: string
    private tmpDir: string

    private constructor(octokit: any, tag: string, bundlePath: string, tmpDir?: string) {
        this.octokit = octokit
        this.tag = tag
        this.bundlePath = bundlePath
        this.tmpDir = tmpDir || process.env.RUNNER_TEMP || "/tmp"
    }

    static async getBundleByTag(token: string, orgRepoSlug: string, tag: string): Promise<Bundle> {
        const octokit = github.getOctokit(token)
        if (tag === "latest") {
            core.debug('Resolving latest CodeQL bundle')
            const { data: release } = await octokit.rest.repos.getLatestRelease({ owner: "github", repo: "codeql-action" })
            core.debug(`Found release tag ${release.tag_name}`)
            tag = release.tag_name;
        }
        const [ org, repo ] = orgRepoSlug.split('/');
        const runnerTemp = process.env.RUNNER_TEMP || "/tmp"
        core.debug(`Retrieving release by tag ${tag}`)
        const { data: bundleRelease } = await octokit.rest.repos.getReleaseByTag({ owner: org, repo: repo, tag: tag })
        core.debug('Locating asset \'codeql-bundle.tar.gz\'')
        const asset = bundleRelease.assets.find((asset: any) => asset.name === 'codeql-bundle.tar.gz')
        if (asset) {
            core.debug(`Downloading asset ${asset.browser_download_url}`)
            const downloadedBundlePath = await tc.downloadTool(asset.browser_download_url)
            core.debug(`Extracting downloaded asset ${downloadedBundlePath}`)
            await tc.extractTar(downloadedBundlePath, runnerTemp)
            core.debug(`Extracted downloaded asset to ${runnerTemp}`)
            const bundlePath = path.join(runnerTemp, 'codeql')
            return new Bundle(octokit, tag, bundlePath, runnerTemp)
        } else {
            throw new Error(`Unable to download the CodeQL bundle version ${tag}`)
        }
    }

    getCodeQL(): CodeQL {
        return new CodeQL(this.bundlePath)
    }

    async addPacks(workspace: string, ...packs: CodeQLPack[]) {
        const concurrencyLimit = Number.parseInt(core.getInput('concurrency-limit')) || 2
        const groupedPacks = packs.reduce((acc, pack) => {
            if (!pack.library) {
                acc.query.push(pack)
            } else if (fs.existsSync(path.join(path.dirname(pack.path), pack.name.replaceAll('-', '_'), 'Customizations.qll'))) {
                acc.customization.push(pack)
            } else {
                acc.library.push(pack)
            }
            return acc
        }, {
            query: [],
            library: [],
            customization: []
        } as { query: CodeQLPack[]; library: CodeQLPack[], customization: CodeQLPack[] })

        core.debug(`Found ${groupedPacks.query.length} query pack(s), ${groupedPacks.library.length} library pack(s), ${groupedPacks.customization.length} customization pack(s)`)
        const codeqlCli = this.getCodeQL()
        const qlpacksPath = path.join(this.bundlePath, 'qlpacks')
        await Promise.all(groupedPacks.library.map(async pack => await codeqlCli.bundlePack(pack.path, qlpacksPath, [workspace])))
        const tempRepackedPacksDir = path.join(this.tmpDir, "repacked-qlpacks")
        const tempStandardPackDir = path.join(this.tmpDir, "standard-qlpacks")
        const availableBundlePacks = await codeqlCli.listPacks(this.bundlePath)
        // TODO: determine how to support multiple customizations packs targeting the same standard qlpack.
        const customizedPacks = await async.mapLimit(groupedPacks.customization, concurrencyLimit, async (pack: CodeQLPack) => {
            core.debug(`Considering pack ${pack.name} as a source of customizations.`)
            const extractor = pack.extractor
            if (extractor === undefined) {
                throw new Error(`Pack ${pack.name} containing customizations doesn't define an extractor required to determine the language pack to customize.`)
            }

            core.debug('Looking at compatible packs')
            const compatibleStandardPacks = availableBundlePacks.filter(pack => pack.name.startsWith('codeql/') && pack.library && pack.extractor === extractor)
            if (compatibleStandardPacks.length != 1) {
                throw new Error(`Found the following list of compatible standard packs when we expected only 1: ${compatibleStandardPacks.map(pack => pack.name).join(',')} `)
            }

            const standardPack = compatibleStandardPacks[0]
            core.debug(`Found compatible standard pack ${standardPack.name} as a target for customization.`)
            const packDefinition = (yaml.load(fs.readFileSync(pack.path, 'utf-8'))) as CodeQLPackYmlSpec
            if (packDefinition.dependencies) {
                core.debug(`Removing dependency on ${standardPack.name} to prevent circular dependency.`)
                delete packDefinition.dependencies[standardPack.name]
                if (Object.keys(packDefinition.dependencies).length == 0) {
                    delete packDefinition.dependencies
                }
            }
            core.debug(`Updating ${pack.name}'s qlpack.yml at ${pack.path}.`)
            fs.writeFileSync(pack.path, yaml.dump(packDefinition))
            // Bundle the pack against the CodeQL bundle. All dependencies should be in the CodeQL bundle.
            await codeqlCli.bundlePack(pack.path, qlpacksPath, [this.bundlePath])

            const standardPackVersionDir = path.dirname(standardPack.path)

            const [scope, name] = standardPack.name.split('/', 2)
            const tempStandardPackNameDir = path.join(tempStandardPackDir, scope, name)
            const tempStandardPackVersionDir = path.join(tempStandardPackNameDir, standardPack.version)
            core.debug(`Copying ${standardPackVersionDir} to  ${tempStandardPackVersionDir}.`)
            await io.cp(standardPackVersionDir, tempStandardPackVersionDir, { recursive: true })

            const standardPackDefinition = (yaml.load(fs.readFileSync(standardPack.path, 'utf-8'))) as CodeQLPackYmlSpec
            standardPackDefinition.dependencies = standardPackDefinition.dependencies || {}
            standardPackDefinition.dependencies[pack.name] = pack.version


            const tempStandardPackDefinition = path.join(tempStandardPackVersionDir, 'qlpack.yml')
            core.debug(`Updating ${standardPack.name}'s qlpack.yml at ${tempStandardPackDefinition} with dependency on ${pack.name}.`)
            core.debug(yaml.dump(standardPackDefinition))
            fs.writeFileSync(tempStandardPackDefinition, yaml.dump(standardPackDefinition))

            core.debug(`Adding ${pack.name} to ${standardPack.name}'s 'Customizations.qll'`)
            const customizationsLibPath = path.join(tempStandardPackVersionDir, 'Customizations.qll')
            const customizationsLib = fs.readFileSync(customizationsLibPath)
            const newCustomizationsLib = customizationsLib.toString() + `\nimport ${pack.name.replaceAll('-', '_').replaceAll('/', '.')}.Customizations\n`
            fs.writeFileSync(customizationsLibPath, newCustomizationsLib)

            // Rebundle the pack against the CodeQL bundle. All dependencies should be in the CodeQL bundle.
            await codeqlCli.rebundlePack(tempStandardPackDefinition, [this.bundlePath], { outputPath: tempRepackedPacksDir })

            return standardPack
        })
        core.debug(`Removing temporary directory ${tempStandardPackDir} holding the modified standard qlpacks`)
        await io.rmRF(tempStandardPackDir)
        core.debug('Finished re-bundling packs')
        await async.eachLimit(customizedPacks, concurrencyLimit, async (pack: CodeQLPack) => {
            core.debug(`Going to move ${pack.name} to bundle`)
            const [scope, name] = pack.name.split('/', 2)
            core.debug(`Bundle path: ${this.bundlePath} scope: ${scope} name: ${name} version: ${pack.version}`)
            const destPath = path.join(this.bundlePath, 'qlpacks', scope, name, pack.version)
            core.debug(`Removing old pack at ${destPath}`)
            await io.rmRF(destPath)
            const srcPath = path.join(tempRepackedPacksDir, scope, name, pack.version)
            core.debug(`Moving new pack from ${srcPath} to ${destPath}`)
            await io.mv(srcPath, destPath)
        })
        await io.rmRF(tempRepackedPacksDir)
        core.debug(`The following packs are customized: ${customizedPacks.map(pack => pack.name).join(',')}`)
        // Assume all library packs the query packs rely on are bundle into the CodeQL bundle.
        // TODO: verify that all dependencies are in the CodeQL bundle.
        await async.eachLimit(groupedPacks.query, concurrencyLimit, async (pack: CodeQLPack) => await codeqlCli.createPack(pack.path, qlpacksPath, [this.bundlePath]))

        const queryPacks = availableBundlePacks.filter(pack => pack.library === false)
        core.debug('Looking at query packs to recompile')
        const tempRecreatedPackDir = path.join(this.tmpDir, "recreated-qlpacks")
        const recreatedPacks = (await async.mapLimit(queryPacks, concurrencyLimit, async (pack: CodeQLPack) => {
            core.debug(`Determining if ${pack.name} needs to be recompiled.`)
            if (pack.dependencies.some(dep => customizedPacks.find(pack => dep.name === pack.name))) {
                core.debug(`Query pack ${pack.name} relies on a customized library pack. Repacking into ${tempRecreatedPackDir}`)

                this.patchDependencyOnSuiteHelpers(pack)
                await codeqlCli.recreatePack(pack.path, [this.bundlePath], { outputPath: tempRecreatedPackDir })
                return pack
            }
        })).filter(pack => pack) as CodeQLPack[]
        core.debug('Finished re-creating packs')
        await async.eachLimit(recreatedPacks, concurrencyLimit, async (pack: CodeQLPack) => {
            core.debug(`Going to move ${pack.name} to bundle`)
            const [scope, name] = pack.name.split('/', 2)
            core.debug(`Bundle path: ${this.bundlePath} scope: ${scope} name: ${name} version: ${pack.version}`)
            const destPath = path.join(this.bundlePath, 'qlpacks', scope, name, pack.version)
            core.debug(`Removing old pack at ${destPath}`)
            await io.rmRF(destPath)
            const srcPath = path.join(tempRecreatedPackDir, scope, name, pack.version)
            core.debug(`Moving new pack from ${srcPath} to ${destPath}`)
            await io.mv(srcPath, destPath)
        })
        await io.rmRF(tempRecreatedPackDir)
    }

    /* 
        A CodeQL bundle can contain query packs that rely on a suite-helper pack that is not part of the bundle.
        This poses a problem when recompiling a query pack based on the dependencies in the bundle.

        This function patches the suite helper dependency to use the one available in the bundle.
        We rely on the compiler for correctness.
    */
    patchDependencyOnSuiteHelpers(pack: CodeQLPack) {
        const suiteHelpersPackName = 'codeql/suite-helpers'
        const packDefinition = (yaml.load(fs.readFileSync(pack.path, 'utf-8'))) as CodeQLPackYmlSpec
        if (packDefinition.dependencies) {
            core.debug(`Patching dependency on 'codeql/suite-helpers' to prevent resolution error.`)
            packDefinition.dependencies[suiteHelpersPackName] = "*"
            fs.writeFileSync(pack.path, yaml.dump(packDefinition))
        }
    }

    async bundle(outputDir: string): Promise<string> {
        const outputPath = path.join(outputDir, 'codeql-bundle.tar.gz')
        core.debug(`Creating CodeQL bundle at: ${outputPath}`)
        const cwd = path.dirname(this.bundlePath)
        const bundleDir = path.relative(path.dirname(this.bundlePath), this.bundlePath)
        core.debug(`Running tar from ${cwd} on ${bundleDir}`)
        await tar.create({
            gzip: true,
            file: outputPath,
            cwd: cwd
        }, [bundleDir])
        return outputPath
    }

    getTag(): string {
        return this.tag
    }
}
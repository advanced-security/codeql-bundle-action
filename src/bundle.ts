import * as core from "@actions/core"
import * as github from "@actions/github"
import * as tc from "@actions/tool-cache"
import * as io from "@actions/io"
import * as path from "path"
import * as fs from "fs"
import * as tar from "tar"
import * as yaml from "js-yaml"
import { CodeQL, CodeQLPack, CodeQLPackDependency } from "./codeql"

interface QLPackDependencies {
    [key: string]: string
}

interface QLPack {
    name: string;
    version: string;
    library: boolean;
    dependencies?: QLPackDependencies
}

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

    static async getBundleByTag(token: string, tag: string): Promise<Bundle> {
        const octokit = github.getOctokit(token)
        const runnerTemp = process.env.RUNNER_TEMP || "/tmp"
        core.debug(`Retrieving release by tag ${tag}`)
        const { data: bundleRelease } = await octokit.rest.repos.getReleaseByTag({ owner: "github", repo: "codeql-action", tag: tag })
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

    static async getLatestBundle(token: string): Promise<Bundle> {
        core.debug('Resolving latest CodeQL bundle')
        const octokit = github.getOctokit(token)
        const { data: release } = await octokit.rest.repos.getLatestRelease({ owner: "github", repo: "codeql-action" })
        core.debug(`Found release tag ${release.tag_name}`)

        return await Bundle.getBundleByTag(token, release.tag_name)
    }

    getCodeQL(): CodeQL {
        return new CodeQL(this.bundlePath)
    }

    async addPacks(workspace: string, ...packs: CodeQLPack[]) {
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

        const codeqlCli = this.getCodeQL()
        const qlpacksPath = path.join(this.bundlePath, 'qlpacks')
        await Promise.all(groupedPacks.library.map(async pack => await codeqlCli.bundlePack(pack.path, qlpacksPath, [workspace])))
        const customizedPacks = await Promise.all(groupedPacks.customization.map(async pack => {
            core.debug(`Considering pack ${pack.name} for as a source of customizations.`)
            const extractor = pack.extractor
            if (extractor === undefined) {
                throw new Error(`Pack ${pack.name} containing customizations doesn't define an extractor required to determine the language pack to customize.`)
            }

            const availablePacks = await codeqlCli.listPacks(this.bundlePath)
            core.debug('Looking at compatible packs')
            const compatibleStandardPacks = availablePacks.filter(pack => pack.name.startsWith('codeql/') && pack.library && pack.extractor === extractor)
            if (compatibleStandardPacks.length != 1) {
                throw new Error(`Found the following list of compatible standard packs when we expected only 1: ${compatibleStandardPacks.map(pack => pack.name).join(',')} `)
            }

            const standardPack = compatibleStandardPacks[0]
            core.debug(`Found compatible standard pack ${standardPack.name} as a target for customization.`)
            const packDefinition = (yaml.load(fs.readFileSync(pack.path, 'utf-8'))) as QLPack
            if (packDefinition.dependencies) {
                core.debug(`Removing dependency on ${standardPack.name} to prevent circular dependency.`)
                delete packDefinition.dependencies[standardPack.name]
                if (Object.keys(packDefinition.dependencies).length == 0) {
                    delete packDefinition.dependencies
                }
            }
            core.debug(`Updating ${pack.name}'s qlpack.yml at ${pack.path}.`)
            fs.writeFileSync(pack.path, yaml.dump(packDefinition))
            await codeqlCli.bundlePack(pack.path, qlpacksPath, [workspace])

            const standardPackDefinition = (yaml.load(fs.readFileSync(standardPack.path, 'utf-8'))) as QLPack
            standardPackDefinition.dependencies = standardPackDefinition.dependencies || {}
            standardPackDefinition.dependencies[pack.name] = pack.version
            core.debug(`Updating ${standardPack.name}'s qlpack.yml at ${standardPack.path} with dependency on ${pack.name}.`)
            core.debug(yaml.dump(standardPackDefinition))
            fs.writeFileSync(standardPack.path, yaml.dump(standardPackDefinition))

            core.debug(`Adding ${pack.name} to ${standardPack.name}'s 'Customizations.qll'`)
            const customizationsLibPath = path.join(path.dirname(standardPack.path), 'Customizations.qll')
            const customizationsLib = fs.readFileSync(customizationsLibPath)
            const newCustomizationsLib = customizationsLib.toString() + `\nimport ${pack.name.replaceAll('-', '_').replaceAll('/', '.')}.Customizations\n`
            fs.writeFileSync(customizationsLibPath, newCustomizationsLib)

            // Rebundle the pack against the CodeQL bundle. All dependencies should be in the CodeQL pack.
            await codeqlCli.rebundlePack(standardPack.path, [this.bundlePath])

            return standardPack
        }))
        core.debug(`The following packs are customized: ${customizedPacks.map(pack => pack.name).join(',')}`)
        // Assume all library packs the query packs rely on are bundle into the CodeQL bundle.
        // TODO: verify that all dependencies are in the CodeQL bundle.
        await Promise.all(groupedPacks.query.map(async pack => await codeqlCli.createPack(pack.path, qlpacksPath, [this.bundlePath])))

        const queryPacks = (await codeqlCli.listPacks(this.bundlePath)).filter(pack => pack.library === false)
        core.debug('Looking at query packs to recompile')
        const tempPackDir = path.join(this.tmpDir, "recreated-qlpacks")
        const recreatedPacks: Array<CodeQLPack> = []
        await Promise.all(queryPacks.map(async pack => {
            core.debug(`Determining if ${pack.name} needs to be recompiled.`)
            if (pack.dependencies.some(dep => customizedPacks.find(pack => dep.name === pack.name))) {
                core.debug(`Query pack ${pack.name} relies on a customized library pack. Repacking into ${tempPackDir}`)

                await codeqlCli.recreatePack(pack.path, [this.bundlePath], { outputPath: tempPackDir })
                recreatedPacks.push(pack)
            }
        }))
        core.debug('Finished re-creating packs')
        await Promise.all(recreatedPacks.map(async pack => {
            core.debug(`Going to move ${pack.name} to bundle`)
            const [scope, name] = pack.name.split('/', 2)
            core.debug(`Bundle path: ${this.bundlePath} scope: ${scope} name: ${name} version: ${pack.version}`)
            const destPath = path.join(this.bundlePath, 'qlpacks', scope, name, pack.version)
            core.debug(`Removing old pack at ${destPath}`)
            await io.rmRF(destPath)
            const srcPath = path.join(tempPackDir, scope, name, pack.version)
            core.debug(`Moving new pack from ${srcPath} to ${destPath}`)
            await io.mv(srcPath, destPath)
        }))
        await io.rmRF(tempPackDir)
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
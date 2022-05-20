import * as core from "@actions/core"
import * as exec from "@actions/exec"
import * as io from "@actions/io"
import * as path from "path"
import * as crypto from "crypto"

export interface CodeQLVersion {
    productName: string;
    vendor: string;
    version: string;
    sha: string;
    branches: string[];
    copyright: string;
    unpackedLocation: string;
    configFileLocation: string;
    configFileFound: boolean;
}

export interface CodeQLPackDependency {
    name: string;
    version: string;
    inclusive: boolean
}
export interface CodeQLPack {
    path: string;
    name: string;
    library: boolean;
    version: string;
    dependencies: CodeQLPackDependency[]
    extractor?: string;
}

export interface RecreatePackOptions {
    outputPath: string;
}

export interface RebundlePackOptions {
    outputPath: string;
}

interface RunResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

export class CodeQL {
    private codeqlHome: string;

    constructor(codeqlHome: string) {
        this.codeqlHome = codeqlHome
    }

    private async run(...args: string[]): Promise<RunResult> {
        let result = { exitCode: 0, stdout: "", stderr: "" }
        const options: exec.ExecOptions = {}
        options.listeners = {
            stdout: (data: Buffer) => {
                result.stdout += data.toString()
            },
            stderr: (data: Buffer) => {
                result.stderr += data.toString()
            }
        }
        const codeqlCli = path.join(this.codeqlHome, 'codeql')
        result.exitCode = await exec.exec(codeqlCli, args, options)
        if (result.exitCode != 0) {
            throw new Error(`CodeQL exited with code ${result.exitCode} and error ${result.stderr} when executing the version command!`)
        }
        return result
    }

    async getVersion(): Promise<CodeQLVersion> {
        let args = ["version", "--format=json"]
        if (core.isDebug()) args.push("-vvvv")
        const result = await this.run(...args)
        return JSON.parse(result.stdout)
    }

    async listPacks(rootDirectory = "."): Promise<CodeQLPack[]> {
        let args = ["pack", "ls", "--format=json"]
        if (core.isDebug()) args.push("-vvvv")
        if (rootDirectory !== ".") {
            args.push(rootDirectory)
        }
        core.debug(`Listing packs in ${rootDirectory}`)
        const result = await this.run(...args)
        const packs = JSON.parse(result.stdout).packs
        return Object.keys(packs).map(path => {
            console.debug(`Listing pack at ${path}`)
            const extractor = packs[path].extractor || undefined
            const dependencies = packs[path].dependencies ? Object.keys(packs[path].dependencies).map(pack => {
                return {
                    name: pack,
                    version: packs[path].dependencies[pack].text,
                    inclusive: packs[path].dependencies[pack].inclusive
                }
            }) : []
            return {
                name: packs[path].name,
                path: path,
                library: packs[path].library,
                version: packs[path].version || "0.0.0",
                dependencies: dependencies,
                extractor: extractor
            }
        })
    }

    async bundlePack(packPath: string, outputPath: string, additionalPacks: string[] = []) {
        let args = ['pack', 'bundle', `--pack-path=${outputPath}`, '--format=json']
        if (core.isDebug()) args.push("-vvvv")
        if (additionalPacks.length > 0) args.push(`--additional-packs=${additionalPacks.join(':')}`)
        args.push(packPath)
        await this.run(...args)
    }

    async rebundlePack(packPath: string, additionalPacks: string[] = [], options?: RebundlePackOptions) {
        const versionDir = path.dirname(packPath)
        const packDir = path.resolve(versionDir, '..')
        const scopeDir = path.resolve(packDir, '..')
        const qlPacksDir = path.resolve(scopeDir, '..')
        const outputPath = options?.outputPath || qlPacksDir
        const tmpDir = process.env.RUNNER_TEMP || "/tmp"
        const tmpPackPath = path.join(tmpDir, path.basename(packDir), path.basename(path.dirname(packPath)), "qlpack.yml")
        core.debug(`Moving ${packDir} to ${tmpDir} before packing.`)
        await io.mv(packDir, tmpDir)
        await this.bundlePack(tmpPackPath, outputPath, additionalPacks)
        await io.rmRF(path.dirname(tmpPackPath))
    }

    async createPack(packPath: string, outputPath: string, additionalPacks: string[] = []) {
        if (packPath.endsWith('qlpack.yml')) {
            packPath = packPath.substring(0, packPath.length - 'qlpack.yml'.length - 1)
        }
        let args = ['pack', 'create', `--output=${outputPath}`, `--threads=0`, '--format=json']
        if (core.isDebug()) args.push("-vvvv")
        if (additionalPacks.length > 0) args.push(`--additional-packs=${additionalPacks.join(':')}`)
        args.push(packPath)
        await this.run(...args)
    }

    async recreatePack(packPath: string, additionalPacks: string[] = [], options?: RecreatePackOptions) {
        const packDir = path.dirname(packPath)
        const version = path.basename(path.dirname(packPath))
        const name = path.basename(path.resolve(path.dirname(packPath), '..'))
        const scope = path.basename(path.resolve(path.dirname(packPath), '..', '..'))
        const qlPacksDir = path.resolve(path.dirname(packPath), '..', '..', '..')
        const outputPath = options?.outputPath || qlPacksDir
        const tmpDir = path.join(process.env.RUNNER_TEMP || "/tmp", `recreate-pack-workdir-${crypto.randomBytes(8).toString('hex')}`)
        const tmpPackDir = path.join(tmpDir, scope, name, version)
        const tmpPackPath = path.join(tmpPackDir, "qlpack.yml")
        core.debug(`Copying ${packDir} to ${tmpPackDir} before creating.`)
        await io.cp(packDir, tmpPackDir, { recursive: true })

        const lockFilePath = path.join(tmpPackDir, 'codeql-pack.lock.yml')
        core.debug(`Removing included lock file at ${lockFilePath}`)
        await io.rmRF(lockFilePath)
        const depPath = path.join(tmpPackDir, '.codeql')
        core.debug(`Removing included dependencies at ${depPath}`)
        await io.rmRF(depPath)
        const cachePath = path.join(tmpPackDir, '.cache')
        core.debug(`Removing included cache at ${cachePath}`)
        await io.rmRF(cachePath)
        await this.createPack(tmpPackPath, outputPath, additionalPacks)
        core.debug(`Removing temp workdir at ${tmpDir}`)
        await io.rmRF(tmpDir)
    }
}
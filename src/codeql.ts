import * as core from "@actions/core"
import * as exec from "@actions/exec"
import * as io from "@actions/io"
import * as path from "path"

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
    extractor: string | undefined;
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
        const result = await this.run("version", "--format=json")
        return JSON.parse(result.stdout)
    }

    async listPacks(rootDirectory = "."): Promise<CodeQLPack[]> {
        let args = ["pack", "ls", "--format=json"]
        if (rootDirectory !== ".") {
            args.push(rootDirectory)
        }
        core.debug(`Listing packs in ${rootDirectory}`)
        const result = await this.run(...args)
        const packs = JSON.parse(result.stdout).packs
        return Object.keys(packs).map(path => {
            console.debug(`Listing pack at ${path}`)
            const extractor = packs[path].extractor || ""
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
                version: packs[path].version,
                dependencies: dependencies,
                extractor: extractor
            }
        })
    }

    async bundlePack(packPath: string, outputPath: string, additionalPacks: string[] = []) {
        let args = ['pack', 'bundle', `--pack-path=${outputPath}`, '--format=json']
        if (additionalPacks.length > 0) args.push(`--additional-packs=${additionalPacks.join(':')}`)
        args.push(packPath)
        await this.run(...args)
    }

    async rebundlePack(packPath: string, additionalPacks: string[] = []) {
        const packDir = path.resolve(path.dirname(packPath), '..')
        const outputPath = path.resolve(packDir, '..', '..')
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
        if (additionalPacks.length > 0) args.push(`--additional-packs=${additionalPacks.join(':')}`)
        args.push(packPath)
        await this.run(...args)
    }

    async recreatePack(packPath: string, additionalPacks: string[] = []) {
        const packDir = path.resolve(path.dirname(packPath), '..')
        const outputPath = path.resolve(packDir, '..', '..')
        const tmpDir = process.env.RUNNER_TEMP || "/tmp"
        const tmpPackDir = path.join(tmpDir, path.basename(packDir), path.basename(path.dirname(packPath)))
        const tmpPackPath = path.join(tmpPackDir, "qlpack.yml")
        core.debug(`Moving ${packDir} to ${tmpDir} before creating.`)
        await io.mv(packDir, tmpDir)

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
        await io.rmRF(path.dirname(tmpPackPath))
    }
}
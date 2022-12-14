"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CodeQL = void 0;
const core = require("@actions/core");
const exec = require("@actions/exec");
const io = require("@actions/io");
const path = require("path");
const crypto = require("crypto");
const yaml = require("js-yaml");
const fs = require("fs");
const semver = require("semver");
class CodeQL {
    constructor(codeqlHome) {
        this.codeqlHome = codeqlHome;
    }
    async run(...args) {
        let result = { exitCode: 0, stdout: "", stderr: "" };
        const options = {};
        options.listeners = {
            stdout: (data) => {
                result.stdout += data.toString();
            },
            stderr: (data) => {
                result.stderr += data.toString();
            }
        };
        const codeqlCli = path.join(this.codeqlHome, 'codeql');
        result.exitCode = await exec.exec(codeqlCli, args, options);
        if (result.exitCode != 0) {
            throw new Error(`CodeQL exited with code ${result.exitCode} and error ${result.stderr} when executing the version command!`);
        }
        return result;
    }
    async getVersion() {
        let args = ["version", "--format=json"];
        if (core.isDebug())
            args.push("-vvvv");
        const result = await this.run(...args);
        return JSON.parse(result.stdout);
    }
    async listPacks(rootDirectory = ".") {
        let args = ["pack", "ls", "--format=json"];
        if (core.isDebug())
            args.push("-vvvv");
        if (rootDirectory !== ".") {
            args.push(rootDirectory);
        }
        core.debug(`Listing packs in ${rootDirectory}`);
        const result = await this.run(...args);
        const packs = JSON.parse(result.stdout).packs;
        return Object.keys(packs).map(path => {
            console.debug(`Listing pack at ${path}`);
            const packDefinition = (yaml.load(fs.readFileSync(path, 'utf-8')));
            const dependencies = packDefinition.dependencies ? Object.keys(packDefinition.dependencies).map(pack => {
                return {
                    name: pack,
                    version: packDefinition.dependencies[pack]
                };
            }) : [];
            return {
                name: packDefinition.name,
                path: path,
                library: packDefinition.library,
                version: packDefinition.version || "0.0.0",
                dependencies: dependencies,
                extractor: packDefinition.extractor
            };
        });
    }
    async bundlePack(packPath, outputPath, additionalPacks = []) {
        let args = ['pack', 'bundle', `--pack-path=${outputPath}`, '--format=json'];
        if (core.isDebug())
            args.push("-vvvv");
        if (additionalPacks.length > 0)
            args.push(`--additional-packs=${additionalPacks.join(':')}`);
        args.push(packPath);
        await this.run(...args);
    }
    async rebundlePack(packPath, additionalPacks = [], options) {
        const versionDir = path.dirname(packPath);
        const packDir = path.resolve(versionDir, '..');
        const scopeDir = path.resolve(packDir, '..');
        const qlPacksDir = path.resolve(scopeDir, '..');
        const outputPath = options?.outputPath || qlPacksDir;
        const tmpDir = process.env.RUNNER_TEMP || "/tmp";
        const tmpPackPath = path.join(tmpDir, path.basename(packDir), path.basename(path.dirname(packPath)), "qlpack.yml");
        core.debug(`Moving ${packDir} to ${tmpDir} before packing.`);
        await io.mv(packDir, tmpDir);
        await this.bundlePack(tmpPackPath, outputPath, additionalPacks);
        await io.rmRF(path.dirname(tmpPackPath));
    }
    async createPack(packPath, outputPath, additionalPacks = []) {
        if (packPath.endsWith('qlpack.yml')) {
            packPath = packPath.substring(0, packPath.length - 'qlpack.yml'.length - 1);
        }
        let args = ['pack', 'create', `--output=${outputPath}`, `--threads=0`, '--format=json'];
        if (core.isDebug())
            args.push("-vvvv");
        if (additionalPacks.length > 0)
            args.push(`--additional-packs=${additionalPacks.join(':')}`);
        if (await this.hasQlxSupport()) {
            core.debug('Recreating pack with QLX precompiled queries.');
            args.push('--qlx');
        }
        args.push(packPath);
        await this.run(...args);
    }
    async recreatePack(packPath, additionalPacks = [], options) {
        const packDir = path.dirname(packPath);
        const version = path.basename(path.dirname(packPath));
        const name = path.basename(path.resolve(path.dirname(packPath), '..'));
        const scope = path.basename(path.resolve(path.dirname(packPath), '..', '..'));
        const qlPacksDir = path.resolve(path.dirname(packPath), '..', '..', '..');
        const outputPath = options?.outputPath || qlPacksDir;
        const tmpDir = path.join(process.env.RUNNER_TEMP || "/tmp", `recreate-pack-workdir-${crypto.randomBytes(8).toString('hex')}`);
        const tmpPackDir = path.join(tmpDir, scope, name, version);
        const tmpPackPath = path.join(tmpPackDir, "qlpack.yml");
        core.debug(`Copying ${packDir} to ${tmpPackDir} before creating.`);
        await io.cp(packDir, tmpPackDir, { recursive: true });
        const lockFilePath = path.join(tmpPackDir, 'codeql-pack.lock.yml');
        core.debug(`Removing included lock file at ${lockFilePath}`);
        await io.rmRF(lockFilePath);
        const depPath = path.join(tmpPackDir, '.codeql');
        core.debug(`Removing included dependencies at ${depPath}`);
        await io.rmRF(depPath);
        const cachePath = path.join(tmpPackDir, '.cache');
        core.debug(`Removing included cache at ${cachePath}`);
        await io.rmRF(cachePath);
        core.debug('Remove qlx compiled queries.');
        await exec.exec('find', [tmpPackDir, '-name', '*.qlx', '-delete']);
        await this.createPack(tmpPackPath, outputPath, additionalPacks);
        core.debug(`Removing temp workdir at ${tmpDir}`);
        await io.rmRF(tmpDir);
    }
    async hasQlxSupport() {
        const version = await this.getVersion();
        return semver.gte(version.version, '2.11.4');
    }
}
exports.CodeQL = CodeQL;
//# sourceMappingURL=codeql.js.map
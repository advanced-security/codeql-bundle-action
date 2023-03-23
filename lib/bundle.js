"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Bundle = void 0;
const core = require("@actions/core");
const github = require("@actions/github");
const rest_1 = require("@octokit/rest");
const tc = require("@actions/tool-cache");
const io = require("@actions/io");
const path = require("path");
const fs = require("fs");
const tar = require("tar");
const yaml = require("js-yaml");
const async = require("async");
const codeql_1 = require("./codeql");
class Bundle {
    constructor(octokit, tag, bundlePath, assetName, platform, tmpDir) {
        this.octokit = octokit;
        this.tag = tag;
        this.bundlePath = bundlePath;
        this.assetName = assetName;
        this.platform = platform;
        this.tmpDir = tmpDir || process.env.RUNNER_TEMP || "/tmp";
    }
    static async getBundleByTag(host, token, orgRepoSlug, tag, platform) {
        const octokit = host ? new rest_1.Octokit({ baseUrl: host, auth: token }) : github.getOctokit(token);
        const [org, repo] = orgRepoSlug.split('/');
        if (tag === "latest") {
            core.debug('Resolving latest CodeQL bundle');
            const { data: release } = await octokit.rest.repos.getLatestRelease({ owner: org, repo: repo });
            core.debug(`Found release tag ${release.tag_name}`);
            tag = release.tag_name;
        }
        const runnerTemp = process.env.RUNNER_TEMP || "/tmp";
        core.debug(`Retrieving release by tag ${tag}`);
        const { data: bundleRelease } = await octokit.rest.repos.getReleaseByTag({ owner: org, repo: repo, tag: tag });
        const assetName = "codeql-bundle" + (platform === "multi-platform" ? "" : platform) + ".tar.gz";
        core.debug(`Locating asset '${assetName}'`);
        const asset = bundleRelease.assets.find((asset) => asset.name === assetName);
        if (asset) {
            core.debug(`Downloading asset ${asset.browser_download_url}`);
            const downloadedBundlePath = await tc.downloadTool(asset.browser_download_url);
            core.debug(`Extracting downloaded asset ${downloadedBundlePath}`);
            // Create a unique directory for the bundle
            const extractedBundleDirectory = path.join(runnerTemp, assetName.replace('.tar.gz', ''));
            await io.mkdirP(extractedBundleDirectory);
            // Extract the bundle
            await tc.extractTar(downloadedBundlePath, extractedBundleDirectory);
            core.debug(`Extracted downloaded asset to ${extractedBundleDirectory}`);
            const bundlePath = path.join(extractedBundleDirectory, 'codeql');
            return new Bundle(octokit, tag, bundlePath, assetName, extractedBundleDirectory);
        }
        else {
            throw new Error(`Unable to download the CodeQL bundle version ${tag}`);
        }
    }
    getCodeQL() {
        return new codeql_1.CodeQL(this.bundlePath);
    }
    async addPacks(workspace, ...packs) {
        const concurrencyLimit = Number.parseInt(core.getInput('concurrency-limit')) || 2;
        const groupedPacks = packs.reduce((acc, pack) => {
            if (!pack.library) {
                acc.query.push(pack);
            }
            else if (fs.existsSync(path.join(path.dirname(pack.path), pack.name.replaceAll('-', '_'), 'Customizations.qll'))) {
                acc.customization.push(pack);
            }
            else {
                acc.library.push(pack);
            }
            return acc;
        }, {
            query: [],
            library: [],
            customization: []
        });
        core.debug(`Found ${groupedPacks.query.length} query pack(s), ${groupedPacks.library.length} library pack(s), ${groupedPacks.customization.length} customization pack(s)`);
        const codeqlCli = this.getCodeQL();
        const qlpacksPath = path.join(this.bundlePath, 'qlpacks');
        await Promise.all(groupedPacks.library.map(async (pack) => await codeqlCli.bundlePack(pack.path, qlpacksPath, [workspace])));
        const tempRepackedPacksDir = path.join(this.tmpDir, "repacked-qlpacks");
        const tempStandardPackDir = path.join(this.tmpDir, "standard-qlpacks");
        const availableBundlePacks = await codeqlCli.listPacks(this.bundlePath);
        // TODO: determine how to support multiple customizations packs targeting the same standard qlpack.
        const customizedPacks = await async.mapLimit(groupedPacks.customization, concurrencyLimit, async (pack) => {
            core.debug(`Considering pack ${pack.name} as a source of customizations.`);
            const extractor = pack.extractor;
            if (extractor === undefined) {
                throw new Error(`Pack ${pack.name} containing customizations doesn't define an extractor required to determine the language pack to customize.`);
            }
            core.debug('Looking at compatible packs');
            const compatibleStandardPacks = availableBundlePacks.filter(pack => pack.name.startsWith('codeql/') && pack.library && pack.extractor === extractor);
            if (compatibleStandardPacks.length != 1) {
                throw new Error(`Found the following list of compatible standard packs when we expected only 1: ${compatibleStandardPacks.map(pack => pack.name).join(',')} `);
            }
            const standardPack = compatibleStandardPacks[0];
            core.debug(`Found compatible standard pack ${standardPack.name} as a target for customization.`);
            const packDefinition = (yaml.load(fs.readFileSync(pack.path, 'utf-8')));
            if (packDefinition.dependencies) {
                core.debug(`Removing dependency on ${standardPack.name} to prevent circular dependency.`);
                delete packDefinition.dependencies[standardPack.name];
                if (Object.keys(packDefinition.dependencies).length == 0) {
                    delete packDefinition.dependencies;
                }
            }
            core.debug(`Updating ${pack.name}'s qlpack.yml at ${pack.path}.`);
            fs.writeFileSync(pack.path, yaml.dump(packDefinition));
            // Bundle the pack against the CodeQL bundle. All dependencies should be in the CodeQL bundle.
            await codeqlCli.bundlePack(pack.path, qlpacksPath, [this.bundlePath]);
            const standardPackVersionDir = path.dirname(standardPack.path);
            const [scope, name] = standardPack.name.split('/', 2);
            const tempStandardPackNameDir = path.join(tempStandardPackDir, scope, name);
            const tempStandardPackVersionDir = path.join(tempStandardPackNameDir, standardPack.version);
            core.debug(`Copying ${standardPackVersionDir} to  ${tempStandardPackVersionDir}.`);
            await io.cp(standardPackVersionDir, tempStandardPackVersionDir, { recursive: true });
            const standardPackDefinition = (yaml.load(fs.readFileSync(standardPack.path, 'utf-8')));
            standardPackDefinition.dependencies = standardPackDefinition.dependencies || {};
            standardPackDefinition.dependencies[pack.name] = pack.version;
            const tempStandardPackDefinition = path.join(tempStandardPackVersionDir, 'qlpack.yml');
            core.debug(`Updating ${standardPack.name}'s qlpack.yml at ${tempStandardPackDefinition} with dependency on ${pack.name}.`);
            core.debug(yaml.dump(standardPackDefinition));
            fs.writeFileSync(tempStandardPackDefinition, yaml.dump(standardPackDefinition));
            core.debug(`Adding ${pack.name} to ${standardPack.name}'s 'Customizations.qll'`);
            const customizationsLibPath = path.join(tempStandardPackVersionDir, 'Customizations.qll');
            const customizationsLib = fs.readFileSync(customizationsLibPath);
            const newCustomizationsLib = customizationsLib.toString() + `\nimport ${pack.name.replaceAll('-', '_').replaceAll('/', '.')}.Customizations\n`;
            fs.writeFileSync(customizationsLibPath, newCustomizationsLib);
            // Rebundle the pack against the CodeQL bundle. All dependencies should be in the CodeQL bundle.
            await codeqlCli.rebundlePack(tempStandardPackDefinition, [this.bundlePath], { outputPath: tempRepackedPacksDir });
            return standardPack;
        });
        core.debug(`Removing temporary directory ${tempStandardPackDir} holding the modified standard qlpacks`);
        await io.rmRF(tempStandardPackDir);
        core.debug('Finished re-bundling packs');
        await async.eachLimit(customizedPacks, concurrencyLimit, async (pack) => {
            core.debug(`Going to move ${pack.name} to bundle`);
            const [scope, name] = pack.name.split('/', 2);
            core.debug(`Bundle path: ${this.bundlePath} scope: ${scope} name: ${name} version: ${pack.version}`);
            const destPath = path.join(this.bundlePath, 'qlpacks', scope, name, pack.version);
            core.debug(`Removing old pack at ${destPath}`);
            await io.rmRF(destPath);
            const srcPath = path.join(tempRepackedPacksDir, scope, name, pack.version);
            core.debug(`Moving new pack from ${srcPath} to ${destPath}`);
            await io.mv(srcPath, destPath);
        });
        await io.rmRF(tempRepackedPacksDir);
        core.debug(`The following packs are customized: ${customizedPacks.map(pack => pack.name).join(',')}`);
        // Assume all library packs the query packs rely on are bundle into the CodeQL bundle.
        // TODO: verify that all dependencies are in the CodeQL bundle.
        await async.eachLimit(groupedPacks.query, concurrencyLimit, async (pack) => await codeqlCli.createPack(pack.path, qlpacksPath, [this.bundlePath]));
        const queryPacks = availableBundlePacks.filter(pack => pack.library === false);
        core.debug('Looking at query packs to recompile');
        const tempRecreatedPackDir = path.join(this.tmpDir, "recreated-qlpacks");
        const recreatedPacks = (await async.mapLimit(queryPacks, concurrencyLimit, async (pack) => {
            core.debug(`Determining if ${pack.name} needs to be recompiled.`);
            if (pack.dependencies.some(dep => customizedPacks.find(pack => dep.name === pack.name))) {
                core.debug(`Query pack ${pack.name} relies on a customized library pack. Repacking into ${tempRecreatedPackDir}`);
                this.patchDependencyOnSuiteHelpers(pack);
                await codeqlCli.recreatePack(pack.path, [this.bundlePath], { outputPath: tempRecreatedPackDir });
                return pack;
            }
        })).filter(pack => pack);
        core.debug('Finished re-creating packs');
        await async.eachLimit(recreatedPacks, concurrencyLimit, async (pack) => {
            core.debug(`Going to move ${pack.name} to bundle`);
            const [scope, name] = pack.name.split('/', 2);
            core.debug(`Bundle path: ${this.bundlePath} scope: ${scope} name: ${name} version: ${pack.version}`);
            const destPath = path.join(this.bundlePath, 'qlpacks', scope, name, pack.version);
            core.debug(`Removing old pack at ${destPath}`);
            await io.rmRF(destPath);
            const srcPath = path.join(tempRecreatedPackDir, scope, name, pack.version);
            core.debug(`Moving new pack from ${srcPath} to ${destPath}`);
            await io.mv(srcPath, destPath);
        });
        await io.rmRF(tempRecreatedPackDir);
    }
    /*
        A CodeQL bundle can contain query packs that rely on a suite-helper pack that is not part of the bundle.
        This poses a problem when recompiling a query pack based on the dependencies in the bundle.

        This function patches the suite helper dependency to use the one available in the bundle.
        We rely on the compiler for correctness.
    */
    patchDependencyOnSuiteHelpers(pack) {
        const suiteHelpersPackName = 'codeql/suite-helpers';
        const packDefinition = (yaml.load(fs.readFileSync(pack.path, 'utf-8')));
        if (packDefinition.dependencies) {
            core.debug(`Patching dependency on 'codeql/suite-helpers' to prevent resolution error.`);
            packDefinition.dependencies[suiteHelpersPackName] = "*";
            fs.writeFileSync(pack.path, yaml.dump(packDefinition));
        }
    }
    async bundle(outputDir) {
        const outputPath = path.join(outputDir, 'codeql-bundle.tar.gz');
        core.debug(`Creating CodeQL bundle at: ${outputPath}`);
        const cwd = path.dirname(this.bundlePath);
        const bundleDir = path.relative(path.dirname(this.bundlePath), this.bundlePath);
        core.debug(`Running tar from ${cwd} on ${bundleDir}`);
        await tar.create({
            gzip: true,
            file: outputPath,
            cwd: cwd
        }, [bundleDir]);
        return outputPath;
    }
    getTag() {
        return this.tag;
    }
    getPlatform() {
        return this.platform;
    }
    getAssetName() {
        return this.assetName;
    }
    getQLPacksPath() {
        return path.join(this.bundlePath, 'qlpacks');
    }
    async replaceQLPacks(otherQLPacksDirectory) {
        core.debug(`Replacing ${this.bundlePath}/qlpacks with ${otherQLPacksDirectory}`);
        await io.rmRF(path.join(this.bundlePath, 'qlpacks'));
        await io.cp(otherQLPacksDirectory, path.join(this.bundlePath, 'qlpacks'));
    }
}
exports.Bundle = Bundle;
//# sourceMappingURL=bundle.js.map
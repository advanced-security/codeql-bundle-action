"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core = require("@actions/core");
const artifact = require("@actions/artifact");
const bundle_1 = require("./bundle");
async function run() {
    let bundleVersion = core.getInput('bundle-version');
    const repository = core.getInput('repository');
    const host = core.getInput('host');
    const packs = core.getInput('packs').split(',').map(s => s.trim()).filter(s => s !== '');
    const workspace = core.getInput('workspace');
    const uploadBundle = core.getBooleanInput('upload');
    const token = core.getInput('token');
    const runnerTemp = process.env.RUNNER_TEMP || "";
    const platforms = core.getInput('platforms').split(',').map(s => s.trim()).filter(s => s !== '');
    // Confirm a platform was specified
    if (platforms.length === 0) {
        core.setFailed(`The provided platforms are empty`);
        return;
    }
    // Ensure all the platforms are valid options
    const validPlatforms = ['linux64', 'osx64', 'windows64', 'multi-platform'];
    const invalidPlatforms = platforms.filter(platform => !validPlatforms.includes(platform));
    if (invalidPlatforms.length > 0) {
        core.setFailed(`The provided platforms are invalid: ${invalidPlatforms.join(',')}`);
        return;
    }
    // log the platforms
    core.debug(`Platforms found: ${platforms.join(',')}`);
    // Download all the bundles
    const bundles = await Promise.all(platforms.map(async (platform) => {
        return await bundle_1.Bundle.getBundleByTag(host, token, repository, bundleVersion, platform);
    }));
    // Get the first (primary) bundle
    const bundle = bundles[0];
    core.setOutput("bundle-tag", bundle.getTag());
    const codeqlCli = bundle.getCodeQL();
    const version = await codeqlCli.getVersion();
    core.debug(`CodeQL CLI version: ${version.version} unpacked at ${version.unpackedLocation}`);
    const availablePacks = await codeqlCli.listPacks(workspace);
    const missingPacks = packs.filter(name => !availablePacks.find(pack => pack.name === name));
    if (missingPacks.length > 0) {
        core.setFailed(`The provided workspace doesn't contain the packs: ${missingPacks.join(',')}`);
        return;
    }
    const packsToAdd = availablePacks.filter(pack => packs.includes(pack.name));
    await bundle.addPacks(workspace, ...packsToAdd);
    // Copy the qlpack from bundle to each of the other bundles
    for (let i = 1; i < bundles.length; i++) {
        const otherBundle = bundles[i];
        await otherBundle.replaceQLPacks(bundle.getQLPacksPath());
    }
    // Bundle each bundle using foreach
    await Promise.all(bundles.map(async (bundle) => {
        const newBundle = await bundle.bundle(runnerTemp);
        core.setOutput(`bundle-path-${bundle.getPlatform()}`, newBundle);
        if (uploadBundle || core.isDebug()) {
            artifact.create().uploadArtifact(bundle.getAssetName(), [newBundle], runnerTemp);
            core.setOutput(`artifact-name-${bundle.getPlatform()}`, bundle.getAssetName());
        }
    }));
}
async function runWrapper() {
    try {
        core.debug('Starting action');
        await run();
    }
    catch (error) {
        core.setFailed(`CodeQL bundle action failed: ${error}`);
        if (core.isDebug()) {
            console.log(error);
        }
    }
}
runWrapper();
//# sourceMappingURL=codeql-bundle-action.js.map
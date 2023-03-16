import * as core from "@actions/core"
import * as artifact from "@actions/artifact"
import { Bundle } from "./bundle"

async function run() {
    let bundleVersion = core.getInput('bundle-version')
    const repository = core.getInput('repository')
    const host = core.getInput('host')
    const packs = core.getInput('packs').split(',').map(s => s.trim()).filter(s => s !== '')
    const workspace = core.getInput('workspace')
    const uploadBundle = core.getBooleanInput('upload')
    const token = core.getInput('token')
    const runnerTemp = process.env.RUNNER_TEMP || ""

    const bundle = await Bundle.getBundleByTag(host, token, repository, bundleVersion)
    core.setOutput("bundle-tag", bundle.getTag())

    const codeqlCli = bundle.getCodeQL()
    const version = await codeqlCli.getVersion()
    core.debug(`CodeQL CLI version: ${version.version} unpacked at ${version.unpackedLocation}`)
    const availablePacks = await codeqlCli.listPacks(workspace)
    const missingPacks = packs.filter(name => !availablePacks.find(pack => pack.name === name))
    if (missingPacks.length > 0) {
        core.setFailed(`The provided workspace doesn't contain the packs: ${missingPacks.join(',')}`)
        return
    }

    const packsToAdd = availablePacks.filter(pack => packs.includes(pack.name))
    await bundle.addPacks(workspace, ...packsToAdd)
    const newBundle = await bundle.bundle(runnerTemp)
    core.setOutput("bundle-path", newBundle)
    if (uploadBundle || core.isDebug()) {
        const artifactName = `codeql-${bundleVersion}.tar.gz`
        artifact.create().uploadArtifact(artifactName, [newBundle], runnerTemp)
        core.setOutput("artifact-name", artifactName)
    }
}

async function runWrapper() {
    try {
        core.debug('Starting action')
        await run();
    } catch (error) {
        core.setFailed(`CodeQL bundle action failed: ${error}`)
        if (core.isDebug()) {
            console.log(error)
        }
    }
}

runWrapper()
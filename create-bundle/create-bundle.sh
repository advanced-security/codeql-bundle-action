#!/bin/bash

set -e

echo "::group::Creating CodeQL bundle."
echo "Using bundle at ${BUNDLE_PATH}."
echo "Using workspace at ${WORKSPACE}."
output_path=${RUNNER_TEMP}/codeql-bundle.tar.gz
opts=()
opts+=("--bundle" "${BUNDLE_PATH}")
opts+=("--workspace" "${WORKSPACE}")
if [[ -n ${PLATFORMS} ]]; then
    echo "Targetting the platforms ${PLATFORMS}."
    for platform in $(echo $PLATFORMS | tr ',' ' '); do
    opts+=("--platform" "${platform}")
    done
    # When building multiple bundles, the output path is the directory containing the bundles
    output_path=${RUNNER_TEMP}/bundles
    mkdir -p ${output_path}
fi
opts+=("--output" "${output_path}")
if [[ -n ${DEFAULT_CODE_SCANNING_CONFIG} ]]; then
    echo "Using code scanning config at ${DEFAULT_CODE_SCANNING_CONFIG} as the default config."
    opts+=("--code-scanning-config" "${DEFAULT_CODE_SCANNING_CONFIG}")
fi

if [[ ${DEBUG} -eq "true" ]]; then
    opts+=("--log DEBUG")
fi


codeql-bundle ${opts[@]} $(echo ${PACKS} | tr ',' ' ')
echo "::endgroup::"

echo "output-path=${output_path}" >> $GITHUB_OUTPUT
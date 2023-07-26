#!/bin/bash

set -e

output_path=${RUNNER_TEMP}/codeql-bundle.tar.gz
opts=()
opts+=("--bundle" "${BUNDLE_PATH}")
opts+=("--workspace" "${WORKSPACE}")
if [[ -n ${PLATFORMS} ]]; then
    for platform in $(echo $PLATFORMS | tr ',' ' '); do
    opts+=("--platform" "${platform}")
    done
    # When building multiple bundles, the output path is the directory containing the bundles
    output_path=${RUNNER_TEMP}/bundles
    mkdir -p ${output_path}
fi
opts+=("--output" "${output_path}")
if [[ -n ${DEFAULT_CODE_SCANNING_CONFIG} ]]; then
    opts+=("--code-scanning-config" "${DEFAULT_CODE_SCANNING_CONFIG}")
fi

codeql-bundle ${opts[@]} $(echo ${PACKS} | tr ',' ' ')

echo "output-path=${output_path}" >> $GITHUB_OUTPUT
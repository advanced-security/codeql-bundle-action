#!/bin/bash

set -e

output_path=${RUNNER_TEMP}/codeql-bundle.tar.gz
platforms=()
if [[ -n ${PLATFORMS} ]]; then
    for platform in $(echo $PLATFORMS | tr ',' ' '); do
        platforms+=("${platform}")
    done
fi

if [[ ${TAG} -ne "latest" ]]; then
    opts+=("${TAG}")
fi

if [[ ${#platforms[@]} -eq 1 ]]; then
    opts+=("--pattern codeql-bundle-${platforms[0]}.tar.gz")
else
    opts+=("--pattern codeql-bundle.tar.gz")
fi

opts+=("--output ${output_path}")

echo gh release download --repo github/codeql-action ${opts[@]}
gh release download --repo github/codeql-action ${opts[@]}

echo "output-path=${output_path}" >> $GITHUB_OUTPUT
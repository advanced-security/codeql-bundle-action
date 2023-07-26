#!/bin/bash

set -e
SCRIPT_DIR=$(cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd)
export RUNNER_TEMP=$(mktemp -d)

trap "{ rm -r "${RUNNER_TEMP}" ; exit 1; }" SIGINT SIGTERM ERR

echo "Runner temp: $RUNNER_TEMP"
export GITHUB_OUTPUT=${RUNNER_TEMP}/github_output
echo "GitHub output: $GITHUB_OUTPUT"

export PLATFORMS="osx64,linux64,win64"
export TAG="latest"

bash $SCRIPT_DIR/../download-bundle/download-bundle.sh

bundle_path=""
while IFS='=' read -r key value; do
    if [[ $key == "output-path" ]]; then
        # The output path is the second value
        bundle_path=$value
    fi
done < $GITHUB_OUTPUT

if [[ -z ${bundle_path} ]]; then
    echo "Failed to download bundle!"
    exit 1
fi

export BUNDLE_PATH=${bundle_path}
export PACKS="test/go-queries,test/go-customizations,test/java-queries,test/cpp-queries,test/javascript-queries" 
export WORKSPACE="${SCRIPT_DIR}/codeql-workspace.yml"
export DEFAULT_CODE_SCANNING_CONFIG="${SCRIPT_DIR}/code-scanning-config.yml"


python3 -mvenv $RUNNER_TEMP/venv
source $RUNNER_TEMP/venv/bin/activate

pip install https://github.com/rvermeulen/codeql-bundle/releases/download/v0.2.0/codeql_bundle-0.2.0-py3-none-any.whl

bash $SCRIPT_DIR/../create-bundle/create-bundle.sh

# Read the output path from the GitHub output file and split each line by the '=' character
output_path=""
while IFS='=' read -r key value; do
    if [[ $key == "output-path" ]]; then
        # The output path is the second value
        output_path=$value
    fi
done < $GITHUB_OUTPUT

if [[ -n ${output_path} ]]; then
    tar cf ${SCRIPT_DIR}/codeql-bundles.tar.gz -C ${output_path} .
else
    echo "Failed to find output path in GitHub output file"
fi

rm -r "${RUNNER_TEMP}"
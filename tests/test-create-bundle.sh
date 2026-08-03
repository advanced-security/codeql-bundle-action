#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
ROOT=$(cd -- "${SCRIPT_DIR}/.." && pwd)
ACTION="${ROOT}/create-bundle/action.yml"
CREATE_BUNDLE="${ROOT}/create-bundle/create-bundle.sh"

temp_dir=$(mktemp -d)
trap 'rm -rf "${temp_dir}"' EXIT

mkdir -p "${temp_dir}/bin"
cat > "${temp_dir}/bin/codeql-bundle" <<'EOF'
#!/usr/bin/env bash
printf '%s\0' "$@" > "${CAPTURE_ARGS}"
EOF
chmod +x "${temp_dir}/bin/codeql-bundle"

assert_action_contains() {
    if ! grep -Fq -- "$1" "${ACTION}"; then
        echo "Expected action.yml to contain: $1" >&2
        exit 1
    fi
}

assert_args() {
    local capture_path="$1"
    shift
    local expected=("$@")
    local actual=()
    local arg
    while IFS= read -r -d '' arg; do
        actual+=("${arg}")
    done < "${capture_path}"

    if [[ "${#actual[@]}" -ne "${#expected[@]}" ]]; then
        echo "Expected ${#expected[@]} arguments, got ${#actual[@]}" >&2
        printf 'Actual argument: <%s>\n' "${actual[@]}" >&2
        exit 1
    fi

    local index
    for ((index = 0; index < ${#expected[@]}; index++)); do
        if [[ "${actual[index]}" != "${expected[index]}" ]]; then
            echo "Argument ${index}: expected <${expected[index]}>, got <${actual[index]}>" >&2
            exit 1
        fi
    done
}

assert_output() {
    local actual
    actual=$(< "$1")
    if [[ "${actual}" != "output-path=$2" ]]; then
        echo "Expected output-path=$2, got ${actual}" >&2
        exit 1
    fi
}

run_default_case() {
    local case_dir="${temp_dir}/default case"
    mkdir -p "${case_dir}"
    export CAPTURE_ARGS="${case_dir}/args"
    export GITHUB_OUTPUT="${case_dir}/github-output"
    export RUNNER_TEMP="${case_dir}/runner temp"
    export BUNDLE_PATH="${case_dir}/source bundle.tar.gz"
    export PACKS="test/pack-one,test/pack-two"
    export WORKSPACE="${case_dir}/workspace path"
    export DEFAULT_CODE_SCANNING_CONFIG=""
    export PLATFORMS=""
    export THREADS=""
    export CACHE_DIR=""
    export CACHE_MANIFEST=""
    export NO_COMPILATION_CACHE="false"
    export NO_PRECOMPILE="false"
    export DEBUG="false"

    bash "${CREATE_BUNDLE}"

    local output_path="${RUNNER_TEMP}/codeql-bundle.tar.gz"
    assert_args "${CAPTURE_ARGS}" \
        "--bundle" "${BUNDLE_PATH}" \
        "--workspace" "${WORKSPACE}" \
        "--output" "${output_path}" \
        "test/pack-one" "test/pack-two"
    assert_output "${GITHUB_OUTPUT}" "${output_path}"
}

run_options_case() {
    local case_dir="${temp_dir}/options case"
    mkdir -p "${case_dir}"
    export CAPTURE_ARGS="${case_dir}/args"
    export GITHUB_OUTPUT="${case_dir}/github-output"
    export RUNNER_TEMP="${case_dir}/runner temp"
    export BUNDLE_PATH="${case_dir}/source bundle.tar.gz"
    export PACKS="test/pack-one, test/pack-two"
    export WORKSPACE="${case_dir}/workspace path"
    export DEFAULT_CODE_SCANNING_CONFIG="${case_dir}/code scanning.yml"
    export PLATFORMS="osx64, linux64"
    export THREADS="6"
    export CACHE_DIR="${case_dir}/cache directory"
    export CACHE_MANIFEST="https://example.test/catalog.json?channel=stable&format=1"
    export NO_COMPILATION_CACHE="true"
    export NO_PRECOMPILE="true"
    export DEBUG="true"

    bash "${CREATE_BUNDLE}"

    local output_path="${RUNNER_TEMP}/bundles"
    assert_args "${CAPTURE_ARGS}" \
        "--bundle" "${BUNDLE_PATH}" \
        "--workspace" "${WORKSPACE}" \
        "--platform" "osx64" \
        "--platform" "linux64" \
        "--output" "${output_path}" \
        "--code-scanning-config" "${DEFAULT_CODE_SCANNING_CONFIG}" \
        "--threads" "${THREADS}" \
        "--cache-dir" "${CACHE_DIR}" \
        "--cache-manifest" "${CACHE_MANIFEST}" \
        "--no-compilation-cache" \
        "--no-precompile" \
        "--log" "DEBUG" \
        "test/pack-one" "test/pack-two"
    assert_output "${GITHUB_OUTPUT}" "${output_path}"
    [[ -d "${output_path}" ]]
}

export PATH="${temp_dir}/bin:${PATH}"
bash -n "${CREATE_BUNDLE}"
assert_action_contains "https://github.com/advanced-security/codeql-bundle/releases/download/v0.5.0/codeql_bundle-0.5.0-py3-none-any.whl"
assert_action_contains 'THREADS: ${{ inputs.threads }}'
assert_action_contains 'CACHE_DIR: ${{ inputs.cache-dir }}'
assert_action_contains 'CACHE_MANIFEST: ${{ inputs.cache-manifest }}'
assert_action_contains 'NO_COMPILATION_CACHE: ${{ inputs.no-compilation-cache }}'
assert_action_contains 'NO_PRECOMPILE: ${{ inputs.no-precompile }}'
assert_action_contains 'ACTION_PATH: ${{ github.action_path }}'
run_default_case
run_options_case

echo "create-bundle action tests passed"

#!/usr/bin/env bash

set -euo pipefail

trim_whitespace() {
    local value="$1"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    printf '%s' "$value"
}

echo "::group::Creating CodeQL bundle."
echo "Using bundle at ${BUNDLE_PATH}."
echo "Using workspace at ${WORKSPACE}."

output_path="${RUNNER_TEMP}/codeql-bundle.tar.gz"
opts=(
    "--bundle" "${BUNDLE_PATH}"
    "--workspace" "${WORKSPACE}"
)

if [[ -n "${PLATFORMS}" ]]; then
    echo "Targeting the platforms ${PLATFORMS}."
    IFS=',' read -r -a platforms <<< "${PLATFORMS}"
    for platform in "${platforms[@]}"; do
        platform="$(trim_whitespace "${platform}")"
        if [[ -n "${platform}" ]]; then
            opts+=("--platform" "${platform}")
        fi
    done

    output_path="${RUNNER_TEMP}/bundles"
    mkdir -p "${output_path}"
fi

opts+=("--output" "${output_path}")

if [[ -n "${DEFAULT_CODE_SCANNING_CONFIG}" ]]; then
    echo "Using code scanning config at ${DEFAULT_CODE_SCANNING_CONFIG} as the default config."
    opts+=("--code-scanning-config" "${DEFAULT_CODE_SCANNING_CONFIG}")
fi

if [[ -n "${THREADS:-}" ]]; then
    opts+=("--threads" "${THREADS}")
fi

if [[ -n "${CACHE_DIR:-}" ]]; then
    opts+=("--cache-dir" "${CACHE_DIR}")
fi

if [[ -n "${CACHE_MANIFEST:-}" ]]; then
    opts+=("--cache-manifest" "${CACHE_MANIFEST}")
fi

if [[ "${NO_COMPILATION_CACHE:-false}" == "true" ]]; then
    opts+=("--no-compilation-cache")
fi

if [[ "${NO_PRECOMPILE:-false}" == "true" ]]; then
    opts+=("--no-precompile")
fi

if [[ "${DEBUG:-false}" == "true" ]]; then
    opts+=("--log" "DEBUG")
fi

IFS=',' read -r -a requested_packs <<< "${PACKS}"
packs=()
for pack in "${requested_packs[@]}"; do
    pack="$(trim_whitespace "${pack}")"
    if [[ -n "${pack}" ]]; then
        packs+=("${pack}")
    fi
done

codeql-bundle "${opts[@]}" "${packs[@]}"
echo "::endgroup::"

printf 'output-path=%s\n' "${output_path}" >> "${GITHUB_OUTPUT}"

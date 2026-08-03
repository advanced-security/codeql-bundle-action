#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)

temp_dir=$(mktemp -d)
trap 'rm -rf "${temp_dir}"' EXIT

fixture_root="${temp_dir}/fixture"
mkdir -p \
    "${fixture_root}/tests" \
    "${fixture_root}/download-bundle" \
    "${fixture_root}/create-bundle" \
    "${temp_dir}/bin"

cp "${SCRIPT_DIR}/run-locally.sh" "${fixture_root}/tests/run-locally.sh"

cat > "${fixture_root}/download-bundle/download-bundle.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

bundle_path="${RUNNER_TEMP}/downloaded bundle.tar.gz"
: > "${bundle_path}"
printf 'bundle-path=%s\n' "${bundle_path}" >> "${GITHUB_OUTPUT}"
EOF

cat > "${fixture_root}/create-bundle/create-bundle.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

expected_bundle_path="${RUNNER_TEMP}/downloaded bundle.tar.gz"
if [[ "${BUNDLE_PATH}" != "${expected_bundle_path}" ]]; then
    echo "Expected BUNDLE_PATH=${expected_bundle_path}, got ${BUNDLE_PATH}" >&2
    exit 1
fi

output_path="${RUNNER_TEMP}/bundles"
mkdir -p "${output_path}"
: > "${output_path}/codeql-bundle-linux64.tar.gz"
printf 'output-path=%s\n' "${output_path}" >> "${GITHUB_OUTPUT}"
EOF

cat > "${temp_dir}/bin/python3" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "-c" ]]; then
    exit 0
fi

if [[ "${1:-}" == "-m" && "${2:-}" == "venv" ]]; then
    mkdir -p "$3/bin"
    : > "$3/bin/activate"
    exit 0
fi

if [[ "${1:-}" == "-m" && "${2:-}" == "pip" ]]; then
    exit 0
fi

echo "Unexpected Python invocation: $*" >&2
exit 1
EOF

chmod +x \
    "${fixture_root}/download-bundle/download-bundle.sh" \
    "${fixture_root}/create-bundle/create-bundle.sh" \
    "${temp_dir}/bin/python3"
ln -s "${temp_dir}/bin/python3" "${temp_dir}/bin/python"

PATH="${temp_dir}/bin:${PATH}" \
    PYTHON="${temp_dir}/bin/python3" \
    bash "${fixture_root}/tests/run-locally.sh"

archive="${fixture_root}/tests/codeql-bundles.tar.gz"
if [[ ! -f "${archive}" ]]; then
    echo "Expected local runner to create ${archive}" >&2
    exit 1
fi

if ! tar -tf "${archive}" | grep -Fxq './codeql-bundle-linux64.tar.gz'; then
    echo "Expected generated archive to contain the mocked bundle" >&2
    exit 1
fi

echo "local runner test passed"

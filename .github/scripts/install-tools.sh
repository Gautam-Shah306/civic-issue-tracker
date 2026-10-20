#!/bin/sh
set -eu

# install-tools.sh: Installs pinned CLI tools from .github/tools.lock
# Verifies SHA-256 checksums before extraction or execution.
# Fails closed on any mismatch, missing entry, or unknown tool.
# Never skips TLS verification.

if [ "$#" -eq 0 ]; then
    echo "ERROR: No tools specified to install" >&2
    echo "Usage: $0 <tool1> [tool2 ...]" >&2
    exit 1
fi

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "${SCRIPT_DIR}/../.." && pwd)

LOCK_FILE="${TOOLS_LOCK:-${REPO_ROOT}/.github/tools.lock}"
if [ ! -f "${LOCK_FILE}" ]; then
    if [ -f ".github/tools.lock" ]; then
        LOCK_FILE=".github/tools.lock"
    else
        echo "ERROR: tools.lock not found at ${LOCK_FILE}" >&2
        exit 1
    fi
fi

# Determine target installation directory
# Target: ${INSTALL_DIR:-$RUNNER_TEMP/bin} or fallback to /tmp/bin
if [ -n "${INSTALL_DIR:-}" ]; then
    TARGET_DIR="${INSTALL_DIR}"
elif [ -n "${RUNNER_TEMP:-}" ]; then
    TARGET_DIR="${RUNNER_TEMP}/bin"
else
    TARGET_DIR="/tmp/bin"
fi

mkdir -p "${TARGET_DIR}"

# Append to GITHUB_PATH if running in GitHub Actions environment
if [ -n "${GITHUB_PATH:-}" ] && [ -w "${GITHUB_PATH}" ]; then
    echo "${TARGET_DIR}" >> "${GITHUB_PATH}"
fi

TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'install-tools')
trap 'rm -rf "${TMP_DIR}"' EXIT

for tool in "$@"; do
    # Find tool entry in tools.lock (exact match at start of line)
    match_line=$(grep "^${tool}|" "${LOCK_FILE}" || true)
    if [ -z "${match_line}" ]; then
        echo "ERROR: Unknown tool or missing entry in tools.lock: ${tool}" >&2
        exit 1
    fi

    tool_version=$(echo "${match_line}" | cut -d'|' -f2)
    tool_url=$(echo "${match_line}" | cut -d'|' -f3)
    expected_sha=$(echo "${match_line}" | cut -d'|' -f4)

    if [ -z "${tool_version}" ] || [ -z "${tool_url}" ] || [ -z "${expected_sha}" ]; then
        echo "ERROR: Corrupt entry in tools.lock for ${tool}" >&2
        exit 1
    fi

    filename=$(basename "${tool_url}")
    download_file="${TMP_DIR}/${filename}"

    echo "--> Downloading ${tool} (${tool_version})..."
    curl -fsSL "${tool_url}" -o "${download_file}"

    echo "--> Verifying SHA-256 for ${tool}..."
    actual_sha=$(sha256sum "${download_file}" | cut -d' ' -f1)
    if [ "${actual_sha}" != "${expected_sha}" ]; then
        echo "ERROR: Checksum mismatch for ${tool}!" >&2
        echo "  Expected: ${expected_sha}" >&2
        echo "  Got:      ${actual_sha}" >&2
        exit 1
    fi

    case "${filename}" in
        *.tar.gz|*.tgz)
            ext_dir="${TMP_DIR}/ext_${tool}"
            mkdir -p "${ext_dir}"
            tar -xzf "${download_file}" -C "${ext_dir}"
            found_bin=$(find "${ext_dir}" -type f -name "${tool}" | head -n 1)
            if [ -z "${found_bin}" ]; then
                echo "ERROR: Binary '${tool}' not found inside archive ${filename}" >&2
                exit 1
            fi
            cp "${found_bin}" "${TARGET_DIR}/${tool}"
            ;;
        *.zip)
            ext_dir="${TMP_DIR}/ext_${tool}"
            mkdir -p "${ext_dir}"
            unzip -q "${download_file}" -d "${ext_dir}"
            found_bin=$(find "${ext_dir}" -type f -name "${tool}" | head -n 1)
            if [ -z "${found_bin}" ]; then
                echo "ERROR: Binary '${tool}' not found inside archive ${filename}" >&2
                exit 1
            fi
            cp "${found_bin}" "${TARGET_DIR}/${tool}"
            ;;
        *)
            cp "${download_file}" "${TARGET_DIR}/${tool}"
            ;;
    esac

    chmod +x "${TARGET_DIR}/${tool}"
    echo "--> Installed ${tool} ${tool_version} to ${TARGET_DIR}/${tool}"
done

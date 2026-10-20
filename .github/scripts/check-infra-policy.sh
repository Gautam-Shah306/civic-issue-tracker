#!/bin/sh
set -eu

# check-infra-policy.sh: Static policy checks for infrastructure, bootstrap scripts, and tools.
# Enforces DevSecOps policy (docs/09, D-054, D-056).

PATH="/usr/bin:${PATH}"
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT="${POLICY_CHECK_ROOT:-$(CDPATH='' cd -- "${SCRIPT_DIR}/../.." && pwd)}"
cd "${REPO_ROOT}"

FAILED=0

fail() {
    echo "POLICY FAILURE: $1" >&2
    FAILED=1
}

# 1. Check for curl piped directly to sh or bash
echo "--> Checking for curl piped directly to shell..."
piped_curl=$(find infra deploy/bootstrap .github/scripts -type f \( -name '*.sh' -o -name '*.tftpl' \) -exec grep -HnE 'curl[^|]*\|\s*(sh|bash)' {} + 2>/dev/null || true)
if [ -n "${piped_curl}" ]; then
    fail "Piping curl directly to shell is forbidden:\n${piped_curl}"
fi

# 2. Check for insecure TLS flags (-k, --insecure, --no-check-certificate, -insecure)
echo "--> Checking for insecure TLS flags..."
insecure_flags=$(find infra deploy/bootstrap .github/scripts .github/workflows -type f \( -name '*.sh' -o -name '*.tftpl' -o -name '*.tf' -o -name '*.yaml' -o -name '*.yml' \) -exec grep -HnE '(^|[[:space:]])(-k|--insecure|--no-check-certificate|-insecure)([[:space:]]|$)' {} + 2>/dev/null || true)
if [ -n "${insecure_flags}" ]; then
    fail "Insecure TLS verification flags are forbidden:\n${insecure_flags}"
fi

# 3. Check for unverified downloads without nearby sha256 verification
echo "--> Checking downloads for nearby sha256 verification..."
# shellcheck disable=SC2044
for f in $(find infra deploy/bootstrap .github/scripts -type f \( -name '*.sh' -o -name '*.tftpl' \)); do
    if [ "$f" = ".github/scripts/check-infra-policy.sh" ]; then
        continue
    fi
    if grep -E 'curl\s+.*(-o|-O|--output)' "$f" >/dev/null 2>&1; then
        if ! grep -qE '(sha256|sha256sum)' "$f"; then
            fail "File $f contains download(s) without nearby sha256 verification"
        fi
    fi
done

# 4. Check for google_service_account_key in Terraform (*.tf files)
echo "--> Checking for google_service_account_key in Terraform..."
sa_keys=$(find infra/terraform -name '*.tf' -not -path '*/.terraform/*' -exec grep -Hn 'google_service_account_key' {} + 2>/dev/null || true)
if [ -n "${sa_keys}" ]; then
    fail "google_service_account_key is strictly forbidden (use Workload Identity Federation):\n${sa_keys}"
fi

# 5. Check for 0.0.0.0/0 outside of the allowed 80/443 firewall rule in Terraform
echo "--> Checking 0.0.0.0/0 CIDR usages in Terraform..."
# shellcheck disable=SC2044
for tf in $(find infra/terraform -name '*.tf' -not -path '*/.terraform/*'); do
    if grep -v '^[[:space:]]*#' "$tf" | grep -q '0\.0\.0\.0/0'; then
        base=$(basename "$tf")
        dir=$(basename "$(dirname "$tf")")
        if [ "$dir" != "gcp-vm" ] || [ "$base" != "main.tf" ]; then
            fail "0.0.0.0/0 found outside gcp-vm module: $tf"
        else
            count=$(grep -v '^[[:space:]]*#' "$tf" | grep -c '0\.0\.0\.0/0' || true)
            if [ "$count" -ne 1 ]; then
                fail "Unexpected multiple occurrences of 0.0.0.0/0 in $tf (count=$count)"
            fi
            if ! grep -q '"80", "443"' "$tf"; then
                fail "0.0.0.0/0 in $tf is not associated with ports 80 and 443"
            fi
        fi
    fi
done

# 6. Check that port 22 is only open to 35.235.240.0/20 in Terraform
echo "--> Checking SSH port 22 firewall restriction..."
ssh_matches=$(find infra/terraform -name '*.tf' -not -path '*/.terraform/*' -exec grep -Hn '"22"' {} + 2>/dev/null || true)
if [ -z "${ssh_matches}" ]; then
    fail "No SSH firewall rule found in infra/terraform"
fi
# shellcheck disable=SC2044
for tf in $(find infra/terraform -name '*.tf' -not -path '*/.terraform/*'); do
    if grep -q '"22"' "$tf"; then
        if ! grep -q '35\.235\.240\.0/20' "$tf"; then
            fail "File $tf opens port 22 to an unauthorized range (must be 35.235.240.0/20 only)"
        fi
    fi
done

# 7. Check that no tfvars file other than .example is tracked in git
echo "--> Checking git tracked tfvars files..."
tracked_tfvars=$(git ls-files '*.tfvars' 'infra/*.tfvars' 'infra/**/*.tfvars' 2>/dev/null || true)
if [ -n "${tracked_tfvars}" ]; then
    fail "A real .tfvars file is tracked in git:\n${tracked_tfvars}"
fi

# 8. Check for 'latest' as a version in Terraform, bootstrap scripts, and workflows
echo "--> Checking for 'latest' version specifiers..."
latest_matches=$(find infra deploy/bootstrap .github/workflows -type f \( -name '*.tf' -o -name '*.sh' -o -name '*.yaml' -o -name '*.yml' -o -name '*.tftpl' \) -not -path '*/.terraform/*' -exec grep -HnE '(:latest\b|version.*=.*"latest"|tag.*=.*"latest"|image.*:.*latest)' {} + 2>/dev/null || true)
if [ -n "${latest_matches}" ]; then
    fail "'latest' version specifier is forbidden:\n${latest_matches}"
fi

# 9. Check tool sha256 parity between variables.tf and tools.lock
echo "--> Checking helm and kubeseal sha256 parity with tools.lock..."
lock_file=".github/tools.lock"
var_file="infra/terraform/modules/k3s-bootstrap/variables.tf"
if [ -f "${lock_file}" ] && [ -f "${var_file}" ]; then
    helm_lock_sha=$(awk -F'|' '$1 == "helm" {print $4}' "${lock_file}" | tr -d '\r\n')
    kubeseal_lock_sha=$(awk -F'|' '$1 == "kubeseal" {print $4}' "${lock_file}" | tr -d '\r\n')

    helm_var_sha=$(sed -n '/variable "helm_sha256"/,/default/p' "${var_file}" | grep 'default' | sed -E 's/.*"([0-9a-f]+)".*/\1/' | tr -d '\r\n')
    kubeseal_var_sha=$(sed -n '/variable "kubeseal_sha256"/,/default/p' "${var_file}" | grep 'default' | sed -E 's/.*"([0-9a-f]+)".*/\1/' | tr -d '\r\n')

    if [ -z "${helm_var_sha}" ] || [ "${helm_var_sha}" != "${helm_lock_sha}" ]; then
        fail "Helm sha256 mismatch: variables.tf (${helm_var_sha}) != tools.lock (${helm_lock_sha})"
    fi
    if [ -z "${kubeseal_var_sha}" ] || [ "${kubeseal_var_sha}" != "${kubeseal_lock_sha}" ]; then
        fail "Kubeseal sha256 mismatch: variables.tf (${kubeseal_var_sha}) != tools.lock (${kubeseal_lock_sha})"
    fi
fi

# 10. Check secret parity between seal-secrets.sh, kind-secrets.sh, and manifests
echo "--> Checking secret parity between bootstrap, test, and workload manifests..."
seal_script="deploy/bootstrap/seal-secrets.sh"
kind_script=".github/scripts/kind-secrets.sh"

if [ -f "${seal_script}" ] && [ -f "${kind_script}" ]; then
    tmp_pairs_dir=$(mktemp -d 2>/dev/null || mktemp -d -t 'policy-pairs')
    seal_pairs="${tmp_pairs_dir}/seal_pairs.txt"
    kind_pairs="${tmp_pairs_dir}/kind_pairs.txt"
    helm_pairs="${tmp_pairs_dir}/helm_pairs.txt"
    k8s_pairs="${tmp_pairs_dir}/k8s_pairs.txt"

    # Extract pairs from scripts
    parse_script_secrets() {
        _script="$1"
        _current_sec=""
        while IFS= read -r _line || [ -n "${_line}" ]; do
            case "${_line}" in
                *seal_and_apply*|*apply_secret*)
                    _current_sec=$(printf '%s\n' "${_line}" | sed -E 's/.*"(civic-[a-z]+)"[[:space:]]+"([a-zA-Z0-9_-]+)".*/\2/')
                    ;;
                *--from-literal=*)
                    _k=$(printf '%s\n' "${_line}" | sed -E 's/.*--from-literal=([^=]+)=.*/\1/')
                    if [ -n "${_current_sec}" ] && [ -n "${_k}" ]; then
                        printf '%s:%s\n' "${_current_sec}" "${_k}"
                    fi
                    ;;
            esac
        done < "${_script}"
    }

    parse_script_secrets "${seal_script}" | sort -u > "${seal_pairs}"
    parse_script_secrets "${kind_script}" | sort -u > "${kind_pairs}"

    if ! cmp -s "${seal_pairs}" "${kind_pairs}"; then
        fail "Secret (name, key) pairs in ${seal_script} do not match ${kind_script}"
    fi

    # Extract secretName/key from deploy/helm/values/*.yaml
    for _val in deploy/helm/values/*.yaml; do
        if [ ! -f "${_val}" ]; then
            continue
        fi
        _curr_sec=""
        while IFS= read -r _line || [ -n "${_line}" ]; do
            case "${_line}" in
                *secretName:*)
                    _curr_sec=$(printf '%s\n' "${_line}" | sed -E 's/.*secretName:[[:space:]]*([a-zA-Z0-9_-]+).*/\1/')
                    ;;
                *key:*)
                    _k=$(printf '%s\n' "${_line}" | sed -E 's/.*key:[[:space:]]*([a-zA-Z0-9_-]+).*/\1/')
                    if [ -n "${_curr_sec}" ] && [ -n "${_k}" ]; then
                        printf '%s:%s\n' "${_curr_sec}" "${_k}"
                        _curr_sec=""
                    fi
                    ;;
            esac
        done < "${_val}"
    done | sort -u > "${helm_pairs}"

    # Extract secretKeyRef from deploy/k8s/*.yaml
    for _manifest in deploy/k8s/*.yaml; do
        if [ ! -f "${_manifest}" ]; then
            continue
        fi
        _in_skr=0
        _skr_name=""
        _skr_key=""
        while IFS= read -r _line || [ -n "${_line}" ]; do
            case "${_line}" in
                *secretKeyRef:*)
                    _in_skr=1
                    _skr_name=""
                    _skr_key=""
                    ;;
                *name:*|*key:*)
                    if [ "${_in_skr}" -eq 1 ]; then
                        if printf '%s\n' "${_line}" | grep -q "name:"; then
                            _skr_name=$(printf '%s\n' "${_line}" | sed -E 's/.*name:[[:space:]]*([a-zA-Z0-9_-]+).*/\1/')
                        elif printf '%s\n' "${_line}" | grep -q "key:"; then
                            _skr_key=$(printf '%s\n' "${_line}" | sed -E 's/.*key:[[:space:]]*([a-zA-Z0-9_-]+).*/\1/')
                        fi
                        if [ -n "${_skr_name}" ] && [ -n "${_skr_key}" ]; then
                            printf '%s:%s\n' "${_skr_name}" "${_skr_key}"
                            _in_skr=0
                            _skr_name=""
                            _skr_key=""
                        fi
                    fi
                    ;;
            esac
        done < "${_manifest}"
    done | sort -u > "${k8s_pairs}"

    # Check that all referenced pairs exist in seal_pairs
    while IFS= read -r _pair || [ -n "${_pair}" ]; do
        [ -z "${_pair}" ] && continue
        if ! grep -q "^${_pair}$" "${seal_pairs}"; then
            fail "Secret reference ${_pair} in Helm values is missing from ${seal_script}"
        fi
    done < "${helm_pairs}"

    while IFS= read -r _pair || [ -n "${_pair}" ]; do
        [ -z "${_pair}" ] && continue
        if ! grep -q "^${_pair}$" "${seal_pairs}"; then
            fail "Secret reference ${_pair} in deploy/k8s is missing from ${seal_script}"
        fi
    done < "${k8s_pairs}"

    rm -rf "${tmp_pairs_dir}"
fi

# 11. Check that actions/checkout SHA is uniform across all workflow files
echo "--> Checking actions/checkout SHA uniformity..."
if [ -d .github/workflows ]; then
    checkout_shas=$(grep -hoE 'actions/checkout@[0-9a-f]{40}' .github/workflows/*.yml 2>/dev/null | sort -u || true)
    checkout_sha_count=$(printf '%s\n' "${checkout_shas}" | grep -c . || true)
    if [ "${checkout_sha_count}" -gt 1 ]; then
        fail "actions/checkout SHA differs between workflow files:\n${checkout_shas}"
    elif [ "${checkout_sha_count}" -eq 0 ]; then
        fail "No actions/checkout SHA found in workflow files"
    fi
fi

# 12. Check that .checkov.yaml contains no skip-check key
echo "--> Checking .checkov.yaml for forbidden skip-check key..."
if [ -f .checkov.yaml ]; then
    if grep -E '^[[:space:]]*skip-check:' .checkov.yaml >/dev/null 2>&1; then
        fail ".checkov.yaml must not contain a skip-check key (inline skips only)"
    fi
fi

# 13. Check that no file under infra, deploy, .github, or docs contains a carriage return
echo "--> Checking for carriage return (CR) characters..."
cr_files=$(find infra deploy .github docs -type f -not -path '*/.terraform/*' -exec grep -l "$(printf '\r')" {} + 2>/dev/null || true)
if [ -n "${cr_files}" ]; then
    fail "Carriage return (\\r) character found in file(s):\n${cr_files}"
fi

if [ "${FAILED}" -ne 0 ]; then
    echo "=== Infrastructure policy check FAILED ===" >&2
    exit 1
fi

echo "=== All infrastructure policy checks PASSED ==="
exit 0

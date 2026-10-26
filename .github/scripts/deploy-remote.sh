#!/usr/bin/env bash
set -euo pipefail

# deploy-remote.sh: Runs on the production VM with sudo
# Deploys application microservices in order via Helm with atomic rollback on failure.

export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT="${SCRIPT_DIR}"

get_service_digest() {
    local svc="$1"
    local file="$2"
    local raw
    raw=$(jq -r --arg s "civic-${svc}" '.[$s] // empty' "${file}")
    if [ -z "${raw}" ]; then
        raw=$(jq -r --arg s "${svc}" '.[$s] // empty' "${file}")
    fi
    if [ -z "${raw}" ]; then
        echo "ERROR: No digest found for ${svc} in ${file}" >&2
        return 1
    fi
    # Accept both sha256:... and repo@sha256:...
    if [[ "${raw}" == *"@"* ]]; then
        echo "${raw##*@}"
    else
        echo "${raw}"
    fi
}

main() {
    local digests_file="${REPO_ROOT}/image-digests.json"
    if [ ! -f "${digests_file}" ]; then
        echo "ERROR: image-digests.json not found at ${digests_file}" >&2
        exit 1
    fi

    local commit_sha="${1:-${COMMIT_SHA:-${GITHUB_SHA:-}}}"
    if [ -z "${commit_sha}" ]; then
        echo "ERROR: Commit SHA must be supplied as argument 1 or via COMMIT_SHA env var" >&2
        exit 1
    fi

    echo "=== Deploying Civic Issue Tracker Services (Commit: ${commit_sha}) ==="

    # Deployment order specified in D3
    local services="auth report notification analytics routing image gateway frontend"

    for svc in ${services}; do
        echo "--> Deploying service: ${svc}..."
        local digest
        digest=$(get_service_digest "${svc}" "${digests_file}")

        helm upgrade --install "${svc}" "${REPO_ROOT}/deploy/helm/civic-service" \
            -n civic-app \
            -f "${REPO_ROOT}/deploy/helm/values/_common.yaml" \
            -f "${REPO_ROOT}/deploy/helm/values/${svc}.yaml" \
            --set "image.tag=${commit_sha}" \
            --set "image.digest=${digest}" \
            --rollback-on-failure --wait --timeout 5m

        echo "  [OK] ${svc} successfully deployed"
    done

    echo "--> Applying Traefik Ingress routing (deploy/k8s/30-ingress.yaml)..."
    kubectl apply -f "${REPO_ROOT}/deploy/k8s/30-ingress.yaml"

    echo "=== Deployment Summary ==="
    echo "--> Helm releases in civic-app:"
    helm list -n civic-app

    echo "--> Pod status across namespaces:"
    kubectl get pods -n civic-app -o wide
    kubectl get pods -n civic-data -o wide

    echo "=== In-Cluster Smoke Test ==="
    # Port forward gateway (3000) and frontend (8080) in civic-app
    kubectl -n civic-app port-forward svc/gateway 3000:3000 >/dev/null 2>&1 &
    pid_gw=$!
    kubectl -n civic-app port-forward svc/frontend 8080:8080 >/dev/null 2>&1 &
    pid_fe=$!

    cleanup_pf() {
        kill "${pid_gw:-}" 2>/dev/null || true
        kill "${pid_fe:-}" 2>/dev/null || true
    }
    trap cleanup_pf EXIT

    local max_retries=12
    local interval=5
    local smoke_pass=0

    for i in $(seq 1 "${max_retries}"); do
        local code_readyz
        local code_jwks
        local code_fe
        code_readyz=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3000/readyz" || true)
        code_jwks=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3000/.well-known/jwks.json" || true)
        code_fe=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:8080/healthz" || true)

        if [ "${code_readyz}" = "200" ] && [ "${code_jwks}" = "200" ] && [ "${code_fe}" = "200" ]; then
            echo "  [PASS] In-cluster smoke tests passed (gateway readyz: 200, jwks: 200, frontend healthz: 200) on attempt ${i}"
            smoke_pass=1
            break
        fi
        echo "  Attempt ${i}/${max_retries}: gateway readyz=${code_readyz}, jwks=${code_jwks}, frontend=${code_fe}. Retrying in ${interval}s..."
        sleep "${interval}"
    done

    if [ "${smoke_pass}" -ne 1 ]; then
        echo "ERROR: In-cluster smoke tests failed after ${max_retries} attempts" >&2
        exit 1
    fi

    echo "=== Remote Deployment and In-Cluster Smoke Tests Completed Successfully ==="
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi

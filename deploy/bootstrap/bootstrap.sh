#!/usr/bin/env bash
set -euo pipefail

# bootstrap.sh: Cluster-layer bootstrap for Civic Issue Tracker on k3s
# Stage 1: 'platform' (cert-manager, sealed-secrets, namespaces, netpols, clusterissuers, db-init cm)
# Stage 2: 'data' (validates Secrets exist, applies stores 20-24, waits for rollouts, runs db-init job)

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: bootstrap.sh must be run as root" >&2
    exit 1
fi

export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH='' cd -- "${SCRIPT_DIR}/../.." && pwd)

STAGE="${1:-}"
if [ "${STAGE}" != "platform" ] && [ "${STAGE}" != "data" ]; then
    echo "Usage: $0 {platform|data}" >&2
    exit 1
fi

# Pinned Helm chart versions and digests
CERT_MANAGER_VERSION="v1.21.2"
CERT_MANAGER_URL="https://charts.jetstack.io/charts/cert-manager-${CERT_MANAGER_VERSION}.tgz"
CERT_MANAGER_SHA256="73a56e1728edd6c99f1f31082618c3259d279a76b7ebd3d4bdc5475c2442d34a"

SEALED_CHART_VERSION="2.20.0"
SEALED_CHART_URL="https://github.com/bitnami-labs/sealed-secrets/releases/download/helm-v${SEALED_CHART_VERSION}/sealed-secrets-${SEALED_CHART_VERSION}.tgz"
SEALED_CHART_SHA256="6092d219c697f3c9ae3a386ba24bfdd86877c5e2fc8892e2af8a810145b990ef"

if [ "${STAGE}" = "platform" ]; then
    echo "=== [STAGE 1: PLATFORM] Starting Cluster Platform Bootstrap ==="

    echo "--> Waiting for k3s node to be Ready..."
    kubectl wait --for=condition=ready node --all --timeout=120s

    echo "--> Waiting for Traefik ingress controller Deployment to exist..."
    TRAEFIK_WAIT_TIMEOUT="${BOOTSTRAP_TRAEFIK_WAIT_TIMEOUT:-300}"
    TRAEFIK_INTERVAL=5
    traefik_elapsed=0
    until kubectl get deployment/traefik -n kube-system >/dev/null 2>&1; do
        if [ "${traefik_elapsed}" -ge "${TRAEFIK_WAIT_TIMEOUT}" ]; then
            echo "ERROR: Timed out waiting for deployment/traefik in kube-system after ${TRAEFIK_WAIT_TIMEOUT}s" >&2
            exit 1
        fi
        sleep "${TRAEFIK_INTERVAL}"
        traefik_elapsed=$((traefik_elapsed + TRAEFIK_INTERVAL))
    done

    echo "--> Waiting for Traefik ingress controller rollout..."
    kubectl rollout status deployment/traefik -n kube-system --timeout=180s

    TMP_DIR=$(mktemp -d /tmp/platform-bootstrap.XXXXXX)
    trap 'rm -rf "${TMP_DIR}"' EXIT

    echo "--> Downloading and verifying cert-manager Helm chart (${CERT_MANAGER_VERSION})..."
    curl -fsSL "${CERT_MANAGER_URL}" -o "${TMP_DIR}/cert-manager.tgz"
    echo "${CERT_MANAGER_SHA256}  ${TMP_DIR}/cert-manager.tgz" | sha256sum -c -

    echo "--> Installing cert-manager via Helm..."
    helm upgrade --install cert-manager "${TMP_DIR}/cert-manager.tgz" \
        --namespace cert-manager \
        --create-namespace \
        --set crds.enabled=true \
        --atomic --wait --timeout 5m

    echo "--> Downloading and verifying Sealed Secrets Helm chart (${SEALED_CHART_VERSION})..."
    curl -fsSL "${SEALED_CHART_URL}" -o "${TMP_DIR}/sealed-secrets.tgz"
    echo "${SEALED_CHART_SHA256}  ${TMP_DIR}/sealed-secrets.tgz" | sha256sum -c -

    echo "--> Installing Sealed Secrets controller via Helm..."
    helm upgrade --install sealed-secrets "${TMP_DIR}/sealed-secrets.tgz" \
        --namespace kube-system \
        --set fullnameOverride=sealed-secrets-controller \
        --atomic --wait --timeout 5m

    echo "--> Applying namespaces and network baseline..."
    kubectl apply -f "${REPO_ROOT}/deploy/k8s/00-namespaces.yaml"
    kubectl apply -f "${REPO_ROOT}/deploy/k8s/10-network-baseline.yaml"

    echo "--> Validating ACME_EMAIL environment variable..."
    if [ -z "${ACME_EMAIL:-}" ] || ! echo "${ACME_EMAIL}" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
        echo "ERROR: ACME_EMAIL environment variable is unset or invalid (format: user@example.com)" >&2
        exit 1
    fi

    echo "--> Applying ClusterIssuers with configured ACME email..."
    TMP_CI="${TMP_DIR}/clusterissuers.yaml"
    sed "s/ACME_EMAIL_PLACEHOLDER/${ACME_EMAIL}/g" "${REPO_ROOT}/deploy/k8s/cert-manager/clusterissuers.yaml" > "${TMP_CI}"
    kubectl apply -f "${TMP_CI}"

    echo "--> Creating db-init-script ConfigMap in civic-data..."
    kubectl create configmap db-init-script \
        --from-file=db-init.sh="${REPO_ROOT}/deploy/compose/db-init/db-init.sh" \
        -n civic-data --dry-run=client -o yaml | kubectl apply -f -

    echo "=== [STAGE 1: PLATFORM] Platform bootstrap completed successfully ==="
    echo "NEXT STEP: Run seal-secrets.sh to generate and seal application credentials."
fi

if [ "${STAGE}" = "data" ]; then
    echo "=== [STAGE 2: DATA] Starting Data Stores Bootstrap ==="

    wait_for_secret() {
        local secret_name="$1"
        local ns="$2"
        local timeout="${BOOTSTRAP_SECRET_WAIT_TIMEOUT:-60}"
        local interval=3
        local elapsed=0
        echo "--> Waiting up to ${timeout}s for secret '${secret_name}' in namespace '${ns}' (Sealed Secrets unseals asynchronously)..."
        until kubectl get secret "${secret_name}" -n "${ns}" >/dev/null 2>&1; do
            if [ "${elapsed}" -ge "${timeout}" ]; then
                echo "ERROR: Timed out waiting for secret '${secret_name}' in namespace '${ns}' after ${timeout}s. Sealed Secrets unseals asynchronously; verify SealedSecret status or run seal-secrets.sh." >&2
                exit 1
            fi
            sleep "${interval}"
            elapsed=$((elapsed + interval))
        done
    }

    echo "--> Checking required Secrets in civic-app..."
    for sec in jwt-public auth-secrets report-secrets notification-secrets analytics-secrets routing-secrets image-secrets gateway-secrets; do
        wait_for_secret "${sec}" "civic-app"
    done

    echo "--> Checking required Secrets in civic-data..."
    for sec in postgres-superuser db-init-secrets rabbitmq-credentials redis-credentials seaweedfs-credentials; do
        wait_for_secret "${sec}" "civic-data"
    done

    echo "--> Applying data store manifests..."
    kubectl apply -f "${REPO_ROOT}/deploy/k8s/20-postgres.yaml"
    kubectl apply -f "${REPO_ROOT}/deploy/k8s/21-rabbitmq.yaml"
    kubectl apply -f "${REPO_ROOT}/deploy/k8s/22-redis.yaml"
    kubectl apply -f "${REPO_ROOT}/deploy/k8s/23-seaweedfs.yaml"
    kubectl apply -f "${REPO_ROOT}/deploy/k8s/24-mailpit.yaml"

    echo "--> Waiting for data store rollouts in civic-data..."
    kubectl rollout status statefulset/postgres -n civic-data --timeout=180s
    kubectl rollout status statefulset/rabbitmq -n civic-data --timeout=180s
    kubectl rollout status statefulset/redis -n civic-data --timeout=180s
    kubectl rollout status statefulset/seaweedfs -n civic-data --timeout=180s
    kubectl rollout status deployment/mailpit -n civic-data --timeout=180s

    echo "--> Running db-init Job..."
    if kubectl get job/db-init -n civic-data >/dev/null 2>&1; then
        failed_status=$(kubectl get job/db-init -n civic-data -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || true)
        if [ "${failed_status}" = "True" ]; then
            echo "ERROR: job/db-init in civic-data has failed. Recent logs:" >&2
            kubectl logs job/db-init -n civic-data --tail=50 >&2 || true
            echo "INSTRUCTIONS: Delete the failed job with 'kubectl delete job db-init -n civic-data' and re-run bootstrap.sh data. Nothing was deleted automatically." >&2
            exit 1
        fi
        complete_status=$(kubectl get job/db-init -n civic-data -o jsonpath='{.status.conditions[?(@.type=="Complete")].status}' 2>/dev/null || true)
        if [ "${complete_status}" = "True" ]; then
            echo "db-init job has already completed successfully."
        else
            echo "Waiting for active db-init job..."
            if ! kubectl wait --for=condition=complete --timeout=120s job/db-init -n civic-data; then
                failed_status=$(kubectl get job/db-init -n civic-data -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || true)
                if [ "${failed_status}" = "True" ]; then
                    echo "ERROR: job/db-init in civic-data failed during execution. Recent logs:" >&2
                    kubectl logs job/db-init -n civic-data --tail=50 >&2 || true
                    echo "INSTRUCTIONS: Delete the failed job with 'kubectl delete job db-init -n civic-data' and re-run bootstrap.sh data. Nothing was deleted automatically." >&2
                fi
                exit 1
            fi
        fi
    else
        kubectl apply -f "${REPO_ROOT}/deploy/k8s/25-db-init-job.yaml"
        if ! kubectl wait --for=condition=complete --timeout=120s job/db-init -n civic-data; then
            failed_status=$(kubectl get job/db-init -n civic-data -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}' 2>/dev/null || true)
            if [ "${failed_status}" = "True" ]; then
                echo "ERROR: job/db-init in civic-data failed during execution. Recent logs:" >&2
                kubectl logs job/db-init -n civic-data --tail=50 >&2 || true
                echo "INSTRUCTIONS: Delete the failed job with 'kubectl delete job db-init -n civic-data' and re-run bootstrap.sh data. Nothing was deleted automatically." >&2
            fi
            exit 1
        fi
    fi

    echo "=== [STAGE 2: DATA] Data stores bootstrap completed successfully ==="
fi

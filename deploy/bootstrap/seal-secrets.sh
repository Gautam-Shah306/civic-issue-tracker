#!/usr/bin/env bash
set -euo pipefail

# seal-secrets.sh: Generates and seals production Secrets using SealedSecrets.
# Ports logic from .github/scripts/kind-secrets.sh with cryptographic randomness.
# Refuses to run if any target Secret already exists to prevent breaking an initialized DB.
# Admin credentials are saved to /root/civic-admin-credentials (mode 0600) and never printed.

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: seal-secrets.sh must be run as root" >&2
    exit 1
fi

export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
SEALED_DIR="${SCRIPT_DIR}/sealed"

echo "=== Civic Issue Tracker: SealedSecrets Generation ==="

# Check prerequisites
if ! command -v kubectl >/dev/null 2>&1; then
    echo "ERROR: kubectl is required" >&2
    exit 1
fi

if ! command -v kubeseal >/dev/null 2>&1; then
    echo "ERROR: kubeseal CLI is required" >&2
    exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
    echo "ERROR: openssl is required" >&2
    exit 1
fi

# Guard: Refuse to run if any target Secret or SealedSecret already exists
SECRETS_APP="jwt-public auth-secrets report-secrets notification-secrets analytics-secrets routing-secrets image-secrets gateway-secrets"
SECRETS_DATA="postgres-superuser db-init-secrets rabbitmq-credentials redis-credentials seaweedfs-credentials"

for sec in ${SECRETS_APP}; do
    if kubectl get secret "${sec}" -n civic-app >/dev/null 2>&1 || kubectl get sealedsecret "${sec}" -n civic-app >/dev/null 2>&1; then
        echo "ERROR: Secret or SealedSecret '${sec}' already exists in namespace 'civic-app'." >&2
        echo "Refusing to overwrite to prevent breaking an initialized database." >&2
        exit 1
    fi
done

for sec in ${SECRETS_DATA}; do
    if kubectl get secret "${sec}" -n civic-data >/dev/null 2>&1 || kubectl get sealedsecret "${sec}" -n civic-data >/dev/null 2>&1; then
        echo "ERROR: Secret or SealedSecret '${sec}' already exists in namespace 'civic-data'." >&2
        echo "Refusing to overwrite to prevent breaking an initialized database." >&2
        exit 1
    fi
done

TMP_DIR=$(mktemp -d /tmp/seal-secrets.XXXXXX)
trap 'rm -rf "${TMP_DIR}"' EXIT

mkdir -p "${SEALED_DIR}"

echo "--> Fetching controller certificate from cluster..."
CERT_FILE="${TMP_DIR}/sealed-secrets-cert.pem"
kubeseal --fetch-cert \
    --controller-name=sealed-secrets-controller \
    --controller-namespace=kube-system > "${CERT_FILE}"

echo "--> Generating Ed25519 signing keypair for JWT..."
openssl genpkey -algorithm ed25519 -out "${TMP_DIR}/private.pem" 2>/dev/null
openssl pkey -in "${TMP_DIR}/private.pem" -pubout -out "${TMP_DIR}/public.pem" 2>/dev/null

JWT_PRIVATE_KEY_B64=$(base64 < "${TMP_DIR}/private.pem" | tr -d '\r\n')
JWT_PUBLIC_KEY_B64=$(base64 < "${TMP_DIR}/public.pem" | tr -d '\r\n')

echo "--> Generating strong random passwords..."
POSTGRES_USER="postgres"
POSTGRES_DB="postgres"
POSTGRES_PASS=$(openssl rand -hex 16)

RABBITMQ_USER="civic"
RABBITMQ_PASS=$(openssl rand -hex 16)

REDIS_PASS=$(openssl rand -hex 16)

S3_ACCESS_KEY=$(openssl rand -hex 8)
S3_SECRET_KEY=$(openssl rand -hex 16)

AUTH_DB_PASS=$(openssl rand -hex 16)
REPORT_DB_PASS=$(openssl rand -hex 16)
NOTIFICATION_DB_PASS=$(openssl rand -hex 16)
ANALYTICS_DB_PASS=$(openssl rand -hex 16)
ANALYTICS_RW_DB_PASS=$(openssl rand -hex 16)
ROUTING_DB_PASS=$(openssl rand -hex 16)
IMAGE_DB_PASS=$(openssl rand -hex 16)

ADMIN_EMAIL="admin@civic.example.test"
ADMIN_PASS=$(openssl rand -hex 16)

# Write bootstrap admin credentials to /root/civic-admin-credentials (mode 0600)
ADMIN_CREDS_FILE="/root/civic-admin-credentials"
cat <<EOF > "${ADMIN_CREDS_FILE}"
BOOTSTRAP_ADMIN_EMAIL=${ADMIN_EMAIL}
BOOTSTRAP_ADMIN_PASSWORD=${ADMIN_PASS}
EOF
chmod 0600 "${ADMIN_CREDS_FILE}"
echo "--> Bootstrap admin credentials saved to ${ADMIN_CREDS_FILE} (mode 0600)"

# Assemble connection URLs with URL-safe credentials
RABBITMQ_URL="amqp://${RABBITMQ_USER}:${RABBITMQ_PASS}@rabbitmq.civic-data.svc.cluster.local:5672"
REDIS_URL="redis://:${REDIS_PASS}@redis.civic-data.svc.cluster.local:6379"

# Helper function: generate plain secret, seal it, save manifest, apply to cluster
seal_and_apply() {
    local ns="$1"
    local name="$2"
    shift 2

    local sealed_manifest="${SEALED_DIR}/${ns}-${name}.yaml"

    kubectl create secret generic "${name}" \
        -n "${ns}" \
        "$@" \
        --dry-run=client -o yaml | \
    kubeseal --cert="${CERT_FILE}" \
        --format=yaml \
        --namespace="${ns}" \
        --name="${name}" > "${sealed_manifest}"

    kubectl apply -f "${sealed_manifest}"
    echo "  [OK] SealedSecret ${ns}/${name} created and applied"
}

echo "--> Sealing and applying civic-data secrets..."
seal_and_apply "civic-data" "postgres-superuser" \
    --from-literal=POSTGRES_USER="${POSTGRES_USER}" \
    --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASS}" \
    --from-literal=POSTGRES_DB="${POSTGRES_DB}"

seal_and_apply "civic-data" "db-init-secrets" \
    --from-literal=POSTGRES_USER="${POSTGRES_USER}" \
    --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASS}" \
    --from-literal=POSTGRES_DB="${POSTGRES_DB}" \
    --from-literal=AUTH_DB_PASSWORD="${AUTH_DB_PASS}" \
    --from-literal=REPORT_DB_PASSWORD="${REPORT_DB_PASS}" \
    --from-literal=NOTIFICATION_DB_PASSWORD="${NOTIFICATION_DB_PASS}" \
    --from-literal=ANALYTICS_DB_PASSWORD="${ANALYTICS_DB_PASS}" \
    --from-literal=ANALYTICS_RW_DB_PASSWORD="${ANALYTICS_RW_DB_PASS}" \
    --from-literal=ROUTING_DB_PASSWORD="${ROUTING_DB_PASS}" \
    --from-literal=IMAGE_DB_PASSWORD="${IMAGE_DB_PASS}"

seal_and_apply "civic-data" "rabbitmq-credentials" \
    --from-literal=RABBITMQ_DEFAULT_USER="${RABBITMQ_USER}" \
    --from-literal=RABBITMQ_DEFAULT_PASS="${RABBITMQ_PASS}"

seal_and_apply "civic-data" "redis-credentials" \
    --from-literal=REDIS_PASSWORD="${REDIS_PASS}"

seal_and_apply "civic-data" "seaweedfs-credentials" \
    --from-literal=AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY}" \
    --from-literal=AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY}"

echo "--> Sealing and applying civic-app secrets..."
seal_and_apply "civic-app" "jwt-public" \
    --from-literal=JWT_PUBLIC_KEY_B64="${JWT_PUBLIC_KEY_B64}"

seal_and_apply "civic-app" "auth-secrets" \
    --from-literal=DB_PASSWORD="${AUTH_DB_PASS}" \
    --from-literal=RABBITMQ_URL="${RABBITMQ_URL}" \
    --from-literal=JWT_PRIVATE_KEY_B64="${JWT_PRIVATE_KEY_B64}" \
    --from-literal=BOOTSTRAP_ADMIN_EMAIL="${ADMIN_EMAIL}" \
    --from-literal=BOOTSTRAP_ADMIN_PASSWORD="${ADMIN_PASS}"

seal_and_apply "civic-app" "report-secrets" \
    --from-literal=DB_PASSWORD="${REPORT_DB_PASS}" \
    --from-literal=RABBITMQ_URL="${RABBITMQ_URL}"

seal_and_apply "civic-app" "notification-secrets" \
    --from-literal=DB_PASSWORD="${NOTIFICATION_DB_PASS}" \
    --from-literal=RABBITMQ_URL="${RABBITMQ_URL}" \
    --from-literal=SMTP_USER="" \
    --from-literal=SMTP_PASSWORD=""

seal_and_apply "civic-app" "analytics-secrets" \
    --from-literal=DB_PASSWORD="${ANALYTICS_RW_DB_PASS}" \
    --from-literal=MIGRATE_DB_PASSWORD="${ANALYTICS_DB_PASS}" \
    --from-literal=RABBITMQ_URL="${RABBITMQ_URL}"

seal_and_apply "civic-app" "routing-secrets" \
    --from-literal=DB_PASSWORD="${ROUTING_DB_PASS}" \
    --from-literal=RABBITMQ_URL="${RABBITMQ_URL}"

seal_and_apply "civic-app" "image-secrets" \
    --from-literal=DB_PASSWORD="${IMAGE_DB_PASS}" \
    --from-literal=RABBITMQ_URL="${RABBITMQ_URL}" \
    --from-literal=AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY}" \
    --from-literal=AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY}"

seal_and_apply "civic-app" "gateway-secrets" \
    --from-literal=REDIS_URL="${REDIS_URL}"

echo "=== All 13 Secrets successfully sealed and applied ==="
echo "Sealed manifests written to: ${SEALED_DIR}"

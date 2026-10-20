#!/bin/sh
set -eu

# kind-secrets.sh: Generates throwaway Kubernetes Secrets for CI kind testing.
# Implements every Secret specified in deploy/k8s/SECRETS.md across both namespaces.
# Masks all generated values with ::add-mask:: and never echoes secret values.

echo "=== Generating Throwaway Secrets for Kind Cluster ==="

# Check prerequisite: kubectl and openssl
if ! command -v kubectl >/dev/null 2>&1; then
    echo "ERROR: kubectl is required" >&2
    exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
    echo "ERROR: openssl is required" >&2
    exit 1
fi

# Masking helper for GitHub Actions
mask_val() {
    if [ -n "${1:-}" ]; then
        echo "::add-mask::${1}"
    fi
}

TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'kind-secrets')
trap 'rm -rf "${TMP_DIR}"' EXIT

# 1. Generate Ed25519 Keypair
openssl genpkey -algorithm ed25519 -out "${TMP_DIR}/private.pem" 2>/dev/null
openssl pkey -in "${TMP_DIR}/private.pem" -pubout -out "${TMP_DIR}/public.pem" 2>/dev/null

JWT_PRIVATE_KEY_B64=$(base64 < "${TMP_DIR}/private.pem" | tr -d '\r\n')
JWT_PUBLIC_KEY_B64=$(base64 < "${TMP_DIR}/public.pem" | tr -d '\r\n')

mask_val "${JWT_PRIVATE_KEY_B64}"
mask_val "${JWT_PUBLIC_KEY_B64}"

# 2. Generate random credentials
POSTGRES_USER="postgres"
POSTGRES_DB="postgres"
POSTGRES_PASS=$(openssl rand -hex 16)
mask_val "${POSTGRES_PASS}"

RABBITMQ_USER="civic"
RABBITMQ_PASS=$(openssl rand -hex 16)
mask_val "${RABBITMQ_PASS}"

REDIS_PASS=$(openssl rand -hex 16)
mask_val "${REDIS_PASS}"

S3_ACCESS_KEY=$(openssl rand -hex 8)
S3_SECRET_KEY=$(openssl rand -hex 16)
mask_val "${S3_ACCESS_KEY}"
mask_val "${S3_SECRET_KEY}"

AUTH_DB_PASS=$(openssl rand -hex 16)
REPORT_DB_PASS=$(openssl rand -hex 16)
NOTIFICATION_DB_PASS=$(openssl rand -hex 16)
ANALYTICS_DB_PASS=$(openssl rand -hex 16)
ANALYTICS_RW_DB_PASS=$(openssl rand -hex 16)
ROUTING_DB_PASS=$(openssl rand -hex 16)
IMAGE_DB_PASS=$(openssl rand -hex 16)

mask_val "${AUTH_DB_PASS}"
mask_val "${REPORT_DB_PASS}"
mask_val "${NOTIFICATION_DB_PASS}"
mask_val "${ANALYTICS_DB_PASS}"
mask_val "${ANALYTICS_RW_DB_PASS}"
mask_val "${ROUTING_DB_PASS}"
mask_val "${IMAGE_DB_PASS}"

ADMIN_EMAIL="admin@civic.example.test"
ADMIN_PASS=$(openssl rand -hex 12) # 24 characters
mask_val "${ADMIN_PASS}"

RABBITMQ_URL="amqp://${RABBITMQ_USER}:${RABBITMQ_PASS}@rabbitmq.civic-data.svc.cluster.local:5672"
REDIS_URL="redis://:${REDIS_PASS}@redis.civic-data.svc.cluster.local:6379"
mask_val "${RABBITMQ_URL}"
mask_val "${REDIS_URL}"

# Helper to create/apply Secret idempotently
apply_secret() {
    ns="$1"
    name="$2"
    shift 2
    kubectl create secret generic "${name}" \
        -n "${ns}" \
        "$@" \
        --dry-run=client -o yaml | kubectl apply -f - >/dev/null
    echo "  [OK] Secret ${ns}/${name} created"
}

echo "--> Applying civic-data secrets..."
apply_secret "civic-data" "postgres-superuser" \
    --from-literal=POSTGRES_USER="${POSTGRES_USER}" \
    --from-literal=POSTGRES_PASSWORD="${POSTGRES_PASS}" \
    --from-literal=POSTGRES_DB="${POSTGRES_DB}"

apply_secret "civic-data" "db-init-secrets" \
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

apply_secret "civic-data" "rabbitmq-credentials" \
    --from-literal=RABBITMQ_DEFAULT_USER="${RABBITMQ_USER}" \
    --from-literal=RABBITMQ_DEFAULT_PASS="${RABBITMQ_PASS}"

apply_secret "civic-data" "redis-credentials" \
    --from-literal=REDIS_PASSWORD="${REDIS_PASS}"

apply_secret "civic-data" "seaweedfs-credentials" \
    --from-literal=AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY}" \
    --from-literal=AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY}"

echo "--> Applying civic-app secrets..."
apply_secret "civic-app" "jwt-public" \
    --from-literal=JWT_PUBLIC_KEY_B64="${JWT_PUBLIC_KEY_B64}"

apply_secret "civic-app" "auth-secrets" \
    --from-literal=DB_PASSWORD="${AUTH_DB_PASS}" \
    --from-literal=RABBITMQ_URL="${RABBITMQ_URL}" \
    --from-literal=JWT_PRIVATE_KEY_B64="${JWT_PRIVATE_KEY_B64}" \
    --from-literal=BOOTSTRAP_ADMIN_EMAIL="${ADMIN_EMAIL}" \
    --from-literal=BOOTSTRAP_ADMIN_PASSWORD="${ADMIN_PASS}"

apply_secret "civic-app" "report-secrets" \
    --from-literal=DB_PASSWORD="${REPORT_DB_PASS}" \
    --from-literal=RABBITMQ_URL="${RABBITMQ_URL}"

apply_secret "civic-app" "notification-secrets" \
    --from-literal=DB_PASSWORD="${NOTIFICATION_DB_PASS}" \
    --from-literal=RABBITMQ_URL="${RABBITMQ_URL}" \
    --from-literal=SMTP_USER="" \
    --from-literal=SMTP_PASSWORD=""

apply_secret "civic-app" "analytics-secrets" \
    --from-literal=DB_PASSWORD="${ANALYTICS_RW_DB_PASS}" \
    --from-literal=MIGRATE_DB_PASSWORD="${ANALYTICS_DB_PASS}" \
    --from-literal=RABBITMQ_URL="${RABBITMQ_URL}"

apply_secret "civic-app" "routing-secrets" \
    --from-literal=DB_PASSWORD="${ROUTING_DB_PASS}" \
    --from-literal=RABBITMQ_URL="${RABBITMQ_URL}"

apply_secret "civic-app" "image-secrets" \
    --from-literal=DB_PASSWORD="${IMAGE_DB_PASS}" \
    --from-literal=RABBITMQ_URL="${RABBITMQ_URL}" \
    --from-literal=AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY}" \
    --from-literal=AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY}"

apply_secret "civic-app" "gateway-secrets" \
    --from-literal=REDIS_URL="${REDIS_URL}"

echo "=== All kind secrets successfully generated and applied ==="

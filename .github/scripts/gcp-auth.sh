#!/bin/sh
set -eu

# gcp-auth.sh: Authenticate to Google Cloud using Workload Identity Federation
# Exclusively uses plain shell (curl, jq) without third-party actions (D-054).
# Masks all tokens and exports CLOUDSDK_AUTH_ACCESS_TOKEN to GITHUB_ENV.

echo "=== Google Cloud Authentication via Workload Identity Federation ==="

# 1. Validate required environment variables from repository variables
for var_name in GCP_PROJECT_ID GCP_PROJECT_NUMBER GCP_WIF_PROVIDER GCP_DEPLOY_SA GCP_ZONE GCP_INSTANCE PUBLIC_HOST; do
    eval "val=\${$var_name:-}"
    if [ -z "$val" ]; then
        echo "ERROR: Required environment variable ${var_name} is unset or empty." >&2
        echo "Configure repository variables in GitHub Settings -> Secrets and variables -> Actions." >&2
        exit 1
    fi
done

# 2. Check for GitHub Actions OIDC environment
if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ] || [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
    echo "ERROR: GitHub Actions OIDC endpoint not available. Ensure 'id-token: write' permission is set on the job." >&2
    exit 1
fi

# 3. Determine Audience for STS token exchange
if echo "${GCP_WIF_PROVIDER}" | grep -q '^//iam\.googleapis\.com/'; then
    AUDIENCE="${GCP_WIF_PROVIDER}"
elif echo "${GCP_WIF_PROVIDER}" | grep -q '^projects/'; then
    AUDIENCE="//iam.googleapis.com/${GCP_WIF_PROVIDER}"
else
    AUDIENCE="//iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/github-actions-pool/providers/${GCP_WIF_PROVIDER}"
fi

handle_curl_failure() {
    step_name="$1"
    status="$2"
    body="$3"
    err_fields=$(printf '%s\n' "${body}" | jq -r '[(.error | if type == "object" then .message else . end), .error_description, .message] | map(select(. != null and . != "")) | join(": ")' 2>/dev/null || true)
    if [ -z "${err_fields}" ]; then
        err_fields="No error details provided in response"
    fi
    echo "ERROR: ${step_name} failed with HTTP status ${status}: ${err_fields}" >&2
    exit 1
}

echo "--> Requesting GitHub OIDC ID token with audience..."
GH_TOKEN_RESPONSE=$(curl -sSL -w "\n%{http_code}" \
    -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" \
    "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${AUDIENCE}")
GH_STATUS=$(printf '%s\n' "${GH_TOKEN_RESPONSE}" | tail -n 1)
GH_BODY=$(printf '%s\n' "${GH_TOKEN_RESPONSE}" | sed '$d')

if [ "${GH_STATUS}" != "200" ]; then
    handle_curl_failure "GitHub OIDC token request" "${GH_STATUS}" "${GH_BODY}"
fi

GH_ID_TOKEN=$(echo "${GH_BODY}" | jq -r '.value // empty')
if [ -z "${GH_ID_TOKEN}" ]; then
    echo "ERROR: Failed to obtain GitHub OIDC token" >&2
    exit 1
fi
echo "::add-mask::${GH_ID_TOKEN}"

# 4. Exchange GitHub OIDC token at Google STS
echo "--> Exchanging OIDC token with Google Security Token Service (STS)..."
STS_RESPONSE=$(curl -sSL -w "\n%{http_code}" -X POST "https://sts.googleapis.com/v1/token" \
    -H "Content-Type: application/json" \
    -d @- <<EOF
{
  "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
  "audience": "${AUDIENCE}",
  "scope": "https://www.googleapis.com/auth/cloud-platform",
  "requested_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "subject_token_type": "urn:ietf:params:oauth:token-type:jwt",
  "subject_token": "${GH_ID_TOKEN}"
}
EOF
)
STS_STATUS=$(printf '%s\n' "${STS_RESPONSE}" | tail -n 1)
STS_BODY=$(printf '%s\n' "${STS_RESPONSE}" | sed '$d')

if [ "${STS_STATUS}" != "200" ]; then
    handle_curl_failure "STS token exchange" "${STS_STATUS}" "${STS_BODY}"
fi

FEDERATED_TOKEN=$(echo "${STS_BODY}" | jq -r '.access_token // empty')
if [ -z "${FEDERATED_TOKEN}" ]; then
    echo "ERROR: STS token exchange failed" >&2
    exit 1
fi
echo "::add-mask::${FEDERATED_TOKEN}"

# 5. Impersonate the deploy service account
echo "--> Impersonating deploy service account: ${GCP_DEPLOY_SA}..."
SA_RESPONSE=$(curl -sSL -w "\n%{http_code}" -X POST \
    "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${GCP_DEPLOY_SA}:generateAccessToken" \
    -H "Authorization: Bearer ${FEDERATED_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{ "scope": ["https://www.googleapis.com/auth/cloud-platform"] }')
SA_STATUS=$(printf '%s\n' "${SA_RESPONSE}" | tail -n 1)
SA_BODY=$(printf '%s\n' "${SA_RESPONSE}" | sed '$d')

if [ "${SA_STATUS}" != "200" ]; then
    handle_curl_failure "Service account impersonation" "${SA_STATUS}" "${SA_BODY}"
fi

ACCESS_TOKEN=$(echo "${SA_BODY}" | jq -r '.accessToken // empty')
if [ -z "${ACCESS_TOKEN}" ]; then
    echo "ERROR: Failed to impersonate service account ${GCP_DEPLOY_SA}" >&2
    exit 1
fi
echo "::add-mask::${ACCESS_TOKEN}"

# 6. Export token to GITHUB_ENV for gcloud CLI
if [ -n "${GITHUB_ENV:-}" ]; then
    echo "CLOUDSDK_AUTH_ACCESS_TOKEN=${ACCESS_TOKEN}" >> "${GITHUB_ENV}"
    echo "CLOUDSDK_CORE_PROJECT=${GCP_PROJECT_ID}" >> "${GITHUB_ENV}"
    echo "CLOUDSDK_CORE_ACCOUNT=${GCP_DEPLOY_SA}" >> "${GITHUB_ENV}"
fi

echo "--> GCP authentication successfully established."

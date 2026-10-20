#!/bin/sh
set -eu

# check-k8s.sh: Kubernetes manifest linting, schema validation, and policy checks.
# Requires helm and kubeconform on PATH.

echo "=== Civic Issue Tracker Kubernetes Policy & Schema Validator ==="

# 0. Check prerequisites
if ! command -v helm >/dev/null 2>&1; then
    echo "ERROR: helm is not installed or not in PATH" >&2
    exit 1
fi

if ! command -v kubeconform >/dev/null 2>&1; then
    echo "ERROR: kubeconform is not installed or not in PATH" >&2
    exit 1
fi

SERVICES="auth report notification analytics routing image gateway frontend"
CHART_DIR="deploy/helm/civic-service"
VALUES_COMMON="deploy/helm/values/_common.yaml"
K8S_DIR="deploy/k8s"

RENDER_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'k8s-render')
trap 'rm -rf "${RENDER_DIR}"' EXIT

# (a) Helm lint each service
echo "--> (a) Running helm lint on 8 services (strict)..."
for svc in ${SERVICES}; do
    svc_values="deploy/helm/values/${svc}.yaml"
    if [ ! -f "${svc_values}" ]; then
        echo "ERROR: Values file missing: ${svc_values}" >&2
        exit 1
    fi
    helm lint "${CHART_DIR}" \
        -f "${VALUES_COMMON}" \
        -f "${svc_values}" \
        --set image.tag=lint \
        --strict >/dev/null
    echo "  [OK] helm lint ${svc}"
done

# (b) Helm template each service to temp dir
echo "--> (b) Rendering templates for each service..."
for svc in ${SERVICES}; do
    svc_values="deploy/helm/values/${svc}.yaml"
    helm template "${svc}" "${CHART_DIR}" \
        -f "${VALUES_COMMON}" \
        -f "${svc_values}" \
        --set image.tag=test > "${RENDER_DIR}/${svc}.yaml"
    echo "  [OK] rendered ${svc}.yaml"
done

# (c) kubeconform on all rendered templates and deploy/k8s files
echo "--> (c) Running kubeconform (Kubernetes v1.35.0, strict)..."
echo "Skipping CRD kinds: ClusterIssuer"
mkdir -p /tmp/kubeconform-cache
kubeconform -strict -summary -kubernetes-version 1.35.0 \
    -cache /tmp/kubeconform-cache \
    -skip ClusterIssuer \
    "${RENDER_DIR}"/*.yaml \
    "${K8S_DIR}"/*.yaml \
    "${K8S_DIR}/cert-manager"/*.yaml

# (d) Policy assertions on rendered chart output
echo "--> (d) Checking policy assertions on rendered chart output..."

# 1. No kind: Secret
if grep -rn "kind:[[:space:]]*Secret" "${RENDER_DIR}" >/dev/null 2>&1; then
    echo "POLICY VIOLATION: Found 'kind: Secret' in rendered chart output!" >&2
    exit 1
fi

# 2. No :latest tag
if grep -rn "image:.*:latest" "${RENDER_DIR}" >/dev/null 2>&1; then
    echo "POLICY VIOLATION: Found image tag ':latest' in rendered chart output!" >&2
    exit 1
fi

# 3. No hostPath, hostNetwork, or privileged: true
if grep -rn "hostPath:" "${RENDER_DIR}" >/dev/null 2>&1; then
    echo "POLICY VIOLATION: Found 'hostPath' in rendered chart output!" >&2
    exit 1
fi

if grep -rn "hostNetwork:[[:space:]]*true" "${RENDER_DIR}" >/dev/null 2>&1; then
    echo "POLICY VIOLATION: Found 'hostNetwork: true' in rendered chart output!" >&2
    exit 1
fi

if grep -rn "privileged:[[:space:]]*true" "${RENDER_DIR}" >/dev/null 2>&1; then
    echo "POLICY VIOLATION: Found 'privileged: true' in rendered chart output!" >&2
    exit 1
fi

# 4. No automountServiceAccountToken: true
if grep -rn "automountServiceAccountToken:[[:space:]]*true" "${RENDER_DIR}" >/dev/null 2>&1; then
    echo "POLICY VIOLATION: Found 'automountServiceAccountToken: true' in rendered chart output!" >&2
    exit 1
fi

# 5. Container security parity per service:
# image count == readOnlyRootFilesystem count == allowPrivilegeEscalation count == requests count == limits count
for svc in ${SERVICES}; do
    rendered_file="${RENDER_DIR}/${svc}.yaml"

    img_count=$(grep -c "^[[:space:]]*image:[[:space:]]*" "${rendered_file}" || true)
    ro_count=$(grep -c "readOnlyRootFilesystem:[[:space:]]*true" "${rendered_file}" || true)
    pe_count=$(grep -c "allowPrivilegeEscalation:[[:space:]]*false" "${rendered_file}" || true)
    req_count=$(grep -c "^[[:space:]]*requests:[[:space:]]*" "${rendered_file}" || true)
    lim_count=$(grep -c "^[[:space:]]*limits:[[:space:]]*" "${rendered_file}" || true)

    if [ "${img_count}" -eq 0 ]; then
        echo "POLICY VIOLATION (${svc}): No container images found" >&2
        exit 1
    fi

    if [ "${img_count}" -ne "${ro_count}" ] || \
       [ "${img_count}" -ne "${pe_count}" ] || \
       [ "${img_count}" -ne "${req_count}" ] || \
       [ "${img_count}" -ne "${lim_count}" ]; then
        echo "POLICY VIOLATION (${svc}): Container spec parity mismatch:" >&2
        echo "  image count:               ${img_count}" >&2
        echo "  readOnlyRootFilesystem:    ${ro_count}" >&2
        echo "  allowPrivilegeEscalation:  ${pe_count}" >&2
        echo "  requests:                  ${req_count}" >&2
        echo "  limits:                    ${lim_count}" >&2
        exit 1
    fi

    # 6. Deployment has startupProbe, livenessProbe, and readinessProbe
    if ! grep -q "startupProbe:" "${rendered_file}"; then
        echo "POLICY VIOLATION (${svc}): Missing startupProbe in Deployment" >&2
        exit 1
    fi
    if ! grep -q "livenessProbe:" "${rendered_file}"; then
        echo "POLICY VIOLATION (${svc}): Missing livenessProbe in Deployment" >&2
        exit 1
    fi
    if ! grep -q "readinessProbe:" "${rendered_file}"; then
        echo "POLICY VIOLATION (${svc}): Missing readinessProbe in Deployment" >&2
        exit 1
    fi

    # 7. NetworkPolicy exists per service
    if ! grep -q "kind:[[:space:]]*NetworkPolicy" "${rendered_file}"; then
        echo "POLICY VIOLATION (${svc}): Missing NetworkPolicy" >&2
        exit 1
    fi

    echo "  [OK] policy verified for ${svc} (${img_count} container(s))"
done

# (e) Policy assertions on deploy/k8s
echo "--> (e) Checking policy assertions on deploy/k8s..."

# 1. Both namespaces have default-deny
if ! grep -q "namespace:[[:space:]]*civic-app" "${K8S_DIR}/10-network-baseline.yaml" || \
   ! grep -q "namespace:[[:space:]]*civic-data" "${K8S_DIR}/10-network-baseline.yaml"; then
    echo "POLICY VIOLATION: deploy/k8s/10-network-baseline.yaml must define policies for both civic-app and civic-data" >&2
    exit 1
fi

app_deny=$(awk '/name:[[:space:]]*default-deny-all/,/policyTypes:/' "${K8S_DIR}/10-network-baseline.yaml" | grep -c "default-deny-all" || true)
if [ "${app_deny}" -lt 2 ]; then
    echo "POLICY VIOLATION: default-deny policy missing for one or both namespaces in deploy/k8s/10-network-baseline.yaml" >&2
    exit 1
fi

# 2. civic-app has pod-security.kubernetes.io/enforce: restricted
if ! grep -q "pod-security.kubernetes.io/enforce:[[:space:]]*restricted" "${K8S_DIR}/00-namespaces.yaml"; then
    echo "POLICY VIOLATION: civic-app must enforce restricted pod-security profile" >&2
    exit 1
fi

# 3. Every image in deploy/k8s carries a digest
while IFS= read -r img_line; do
    case "${img_line}" in
        *@sha256:*) ;;
        *)
            echo "POLICY VIOLATION: Image reference in deploy/k8s lacks @sha256 digest: ${img_line}" >&2
            exit 1
            ;;
    esac
done <<EOF
$(grep "^[[:space:]]*image:[[:space:]]*" "${K8S_DIR}"/*.yaml || true)
EOF

# 4. No kind: Secret in deploy/k8s
if grep -rn "kind:[[:space:]]*Secret" "${K8S_DIR}" >/dev/null 2>&1; then
    echo "POLICY VIOLATION: Found 'kind: Secret' in deploy/k8s manifests!" >&2
    exit 1
fi

echo "  [OK] deploy/k8s policies verified"

echo "PASS"
exit 0

# Deployment Guide: Civic Issue Tracker

This directory contains the deployment configurations for the Civic Issue Tracker across local Docker Compose and Kubernetes environments.

---

## 1. Directory Layout

- `deploy/compose/`: Local multi-container development environment via Docker Compose.
- `deploy/helm/civic-service/`: Shared Helm chart for all 8 application microservices (one release per service, D-052).
- `deploy/helm/values/`: Per-service values files:
  - `_common.yaml`: Shared cluster configuration (DNS, namespaces, hostnames, peers map).
  - `<service>.yaml`: Per-service resource specifications, probes, replica counts, env mappings, and secrets references.
- `deploy/k8s/`: Plain Kubernetes manifests for cluster baseline and data stores:
  - `00-namespaces.yaml`: Namespaces `civic-app` (PSS restricted) and `civic-data` (PSS baseline).
  - `10-network-baseline.yaml`: Default-deny ingress/egress, CoreDNS egress, cert-manager HTTP-01 solver ingress.
  - `20-postgres.yaml`: PostgreSQL StatefulSet (5Gi PVC) and ClusterIP service.
  - `21-rabbitmq.yaml`: RabbitMQ StatefulSet (1Gi PVC) and ClusterIP service.
  - `22-redis.yaml`: Redis StatefulSet (emptyDir) and ClusterIP service.
  - `23-seaweedfs.yaml`: SeaweedFS StatefulSet (5Gi PVC) and S3 ClusterIP service.
  - `24-mailpit.yaml`: Mailpit Deployment (stateless) and ClusterIP service.
  - `25-db-init-job.yaml`: PostGIS database initialization Job.
  - `30-ingress.yaml`: Traefik Ingress routing `/api` and `/.well-known` to Gateway, `/` to Frontend.
  - `cert-manager/clusterissuers.yaml`: Let's Encrypt staging and production ClusterIssuers.
  - `SECRETS.md`: Specification of all Secret names and keys required across namespaces.
- `.github/tools.lock`: Checksum-pinned lockfile for all 9 CLI tools (D-054).
- `.github/scripts/`: Tool installation and validation scripts:
  - `install-tools.sh`: POSIX installer with pre-execution SHA-256 verification (D-054).
  - `check-k8s.sh`: Schema validation and policy check script (C-01/C-02).
  - `check-allowlist.sh`: Vulnerability allowlist validator (D-024, D-054).
  - `kind-secrets.sh`: Generates throwaway secrets for kind CI smoke test (D-053, D-054).
- `.github/security/vuln-allowlist.txt`: Vulnerability scan exception allowlist (D-024).
- `.github/workflows/`:
  - `k8s.yml`: Kubernetes manifest and Helm chart policy validation (Prompt 5).
  - `images.yml`: Container image pipeline, Hadolint, Syft SBOM, Grype scan, kind install, and GHCR publish (D-054).
  - `deps.yml`: OSV-Scanner dependency scanning (D-054).

---

## 2. Cluster Bootstrap Order on the VM (D-056)

The bootstrap sequence on the provisioned GCP VM is executed in strict stages (run as root with `sudo`):

0. **First-Run Setup (Copy Deploy Directory to VM):**
   Copy the `deploy/` directory to the VM once using `gcloud compute scp --recurse --tunnel-through-iap` before running `bootstrap.sh platform`, because the automated deploy workflow only copies on its own runs:
   ```bash
   gcloud compute scp --recurse --tunnel-through-iap deploy civic-vm:~/ --zone=asia-south1-a
   ```

1. **Platform Stage:**
   Installs cert-manager and Sealed Secrets from verified charts, applies baseline namespaces and network policies, configures ClusterIssuers, and registers the db-init ConfigMap:
   ```bash
   sudo ACME_EMAIL=admin@example.com bash deploy/bootstrap/bootstrap.sh platform
   ```

2. **Seal Secrets:**
   Generates cryptographic credentials, creates SealedSecrets, applies them to the cluster, and records the initial administrator credentials in `/root/civic-admin-credentials` (mode 0600):
   ```bash
   sudo bash deploy/bootstrap/seal-secrets.sh
   ```

3. **Data Stage:**
   Verifies all required Secrets exist, rolls out PostgreSQL, RabbitMQ, Redis, SeaweedFS, and Mailpit, and executes the PostGIS initialization job:
   ```bash
   sudo bash deploy/bootstrap/bootstrap.sh data
   ```

4. **First Application Deploy:**
   Deploys all 8 microservices via Helm and applies the public ingress:
   ```bash
   sudo bash .github/scripts/deploy-remote.sh
   ```

### Clean-Reset Recipe for Failed `seal-secrets.sh`
If `seal-secrets.sh` fails or needs to be re-run, delete the 13 Secrets and SealedSecrets in `civic-app` and `civic-data`, then re-run `seal-secrets.sh`. Note: This clean reset is safe ONLY before `db-init` has run:
```bash
# Delete in civic-app:
kubectl delete secret,sealedsecret jwt-public auth-secrets report-secrets notification-secrets analytics-secrets routing-secrets image-secrets gateway-secrets -n civic-app --ignore-not-found

# Delete in civic-data:
kubectl delete secret,sealedsecret postgres-superuser db-init-secrets rabbitmq-credentials redis-credentials seaweedfs-credentials -n civic-data --ignore-not-found

# Re-run seal-secrets.sh
sudo bash deploy/bootstrap/seal-secrets.sh
```

### Recovery from `db-init` Failure
If the `db-init` Job fails during `bootstrap.sh data`, inspect the container logs:
```bash
kubectl logs job/db-init -n civic-data --tail=50
```
Resolve the root cause, delete the failed Job manually (scripts do not delete resources automatically):
```bash
kubectl delete job db-init -n civic-data
```
And re-run the data stage:
```bash
sudo bash deploy/bootstrap/bootstrap.sh data
```

### Troubleshooting: New-Pod NetworkPolicy Programming Window (k3s / kube-router)
On k3s with kube-router CNI, a newly started pod's NetworkPolicy allow rules are programmed asynchronously in the host datapath several seconds after the pod begins executing (measured ~4 s on live clusters).
- **Symptom:** `Connection refused` (or `no response`) during the first few seconds of a Job connecting to internal stores like PostgreSQL, while long-running services reconnect automatically with backoff (D-038).
- **Where the waits are:**
  1. `deploy/k8s/25-db-init-job.yaml`: Built-in `pg_isready` loop (up to 120 s) polls PostgreSQL until accepting connections before running the SQL initialization script.
  2. `deploy/helm/civic-service/templates/migrate-job.yaml`: Chart migration hook Jobs include a hardened `wait-for-db` init container running `pg_isready` (up to `migrate.waitForDb.timeoutSeconds`, default 120 s) using the node-cached PostgreSQL image before the migration script starts (D-058).
  3. `deploy/bootstrap/bootstrap.sh`: Stage `data` executes `kubectl wait --for=condition=ready pod` across all 5 data store pods before launching `db-init`.

---

## 3. Operator Access via IAP Tunnel

Public port 22 is closed to the internet. Access is mediated strictly through the Google Cloud Identity-Aware Proxy (IAP) CIDR `35.235.240.0/20`.

### SSH to the VM:
```bash
gcloud compute ssh civic-vm --zone=asia-south1-a --tunnel-through-iap
```

### Port-Forwarding Internal Stores (Mailpit, RabbitMQ, SeaweedFS):
To access management dashboards locally without exposing ports publicly, establish an SSH tunnel with local port forwarding:
```bash
# 1. Establish IAP SSH tunnel forwarding local ports to the VM:
gcloud compute ssh civic-vm --zone=asia-south1-a --tunnel-through-iap -- \
  -L 8025:127.0.0.1:8025 \
  -L 15672:127.0.0.1:15672 \
  -L 8333:127.0.0.1:8333

# 2. In the VM session (or via background task), forward cluster ClusterIP services to localhost:
kubectl port-forward -n civic-data svc/mailpit 8025:8025 --address 127.0.0.1 &
kubectl port-forward -n civic-data svc/rabbitmq 15672:15672 --address 127.0.0.1 &
kubectl port-forward -n civic-data svc/seaweedfs 8333:8333 --address 127.0.0.1 &

# 3. Access management interfaces on your local workstation:
# Mailpit UI:    http://localhost:8025
# RabbitMQ UI:   http://localhost:15672
# SeaweedFS S3:  http://localhost:8333
```

---

## 4. Validation and Policy Checks

Manifests are validated for schema correctness (Kubernetes v1.35.0 strict), chart linting, and policy constraints via `.github/scripts/check-k8s.sh` and static analysis via `.github/scripts/check-infra-policy.sh` and Checkov.

---

## 5. Verified only at cluster time (Prompts 6-7, D-055, D-056)

The following items cannot be fully verified via static checks or kind CI runs and are scheduled for live cluster validation on GCP:

- **Two Replicas for Gateway and Report:** Kind CI runs 1 replica due to absence of metrics-server; two replicas with HPA scaling are verified on k3s (D-055 item 9).
- **Traefik Redirect and Client IP:** HTTP-to-HTTPS 301 permanent redirect and client IP preservation (`externalTrafficPolicy: Local`) verified through Traefik HelmChartConfig.
- **VM Startup Script:** Execution of `startup.sh.tftpl` on a real Ubuntu 24.04 GCP Compute Engine instance (k3s binary download, SHA-256 verification, and service initialization).
- **Workload Identity Federation:** The OIDC token exchange from GitHub Actions to Google Cloud STS and deploy service account impersonation (`.github/scripts/gcp-auth.sh`).
- **OS Login Admin Permissions:** `roles/compute.osAdminLogin` and IAP tunnel authorization for the deploy service account.
- **Data-store Volume Ownership:** SeaweedFS, RabbitMQ, and PostgreSQL runtime permissions on k3s `local-path` persistent storage.
- **Image Service S3 Bucket Creation:** Idempotent S3 bucket initialization on SeaweedFS at cluster time.

---

## 6. GitHub Actions Continuous Deployment Setup

### Numeric GitHub Owner ID
For Workload Identity Federation OIDC trust pinning, Terraform requires the immutable numeric GitHub user/organization ID (`github_repository_owner_id`).
To look up your numeric ID, query the public GitHub API:
```bash
curl -s https://api.github.com/users/<owner> | jq .id
```
This numeric ID is configured strictly in `infra/terraform/envs/prod/terraform.tfvars` (never committed to git).

### Repository Variables for Deploy Job
The automated CD deploy job in `.github/workflows/images.yml` requires the following repository variables configured in GitHub repository settings:
- `DEPLOY_ENABLED`
- `GCP_PROJECT_ID`
- `GCP_PROJECT_NUMBER`
- `GCP_WIF_PROVIDER`
- `GCP_DEPLOY_SA`
- `GCP_ZONE`
- `GCP_INSTANCE`
- `PUBLIC_HOST`
- `CERT_ISSUER`

> [!IMPORTANT]
> `DEPLOY_ENABLED` must remain unset (or empty) until the VM is provisioned, k3s is active, and cluster bootstrap stages 1–3 have completed.

### Staging-then-Production Issuer Switch
The application initially deploys with the Let's Encrypt staging issuer to verify ACME challenge validation and routing without hitting Let's Encrypt production rate limits.
To switch to production:
1. Edit the `cert-manager.io/cluster-issuer` annotation in `deploy/k8s/30-ingress.yaml` to specify `letsencrypt-prod`.
2. Update the repository variable `CERT_ISSUER` to `letsencrypt-prod`.

## Repository secrets and variables (deploy job)

Secrets (masked in logs): GCP_PROJECT_ID, GCP_PROJECT_NUMBER, GCP_WIF_PROVIDER, GCP_DEPLOY_SA.
Variables: GCP_ZONE, GCP_INSTANCE, PUBLIC_HOST, CERT_ISSUER (letsencrypt-staging or letsencrypt-prod), DEPLOY_ENABLED (true only when the cluster is ready). See D-059.

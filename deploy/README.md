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

---

## 2. Cluster Bootstrap Order (PLAN — Not Yet Run)

The bootstrap sequence must be executed in strict dependency order:

1. **Namespaces:** Apply `deploy/k8s/00-namespaces.yaml` to enforce Pod Security Standards.
2. **Baseline Network Policies:** Apply `deploy/k8s/10-network-baseline.yaml` to establish default-deny rules and DNS allowances.
3. **Secrets:** Apply SealedSecrets for `civic-data` and `civic-app` (see `deploy/k8s/SECRETS.md`).
4. **Data Stores:** Apply data store manifests in `civic-data`:
   ```bash
   kubectl apply -f deploy/k8s/20-postgres.yaml
   kubectl apply -f deploy/k8s/21-rabbitmq.yaml
   kubectl apply -f deploy/k8s/22-redis.yaml
   kubectl apply -f deploy/k8s/23-seaweedfs.yaml
   kubectl apply -f deploy/k8s/24-mailpit.yaml
   ```
5. **Database Initialization:** Mount single-source script and run initialization Job:
   ```bash
   kubectl create configmap db-init-script \
     --from-file=db-init.sh=deploy/compose/db-init/db-init.sh \
     -n civic-data --dry-run=client -o yaml | kubectl apply -f -
   kubectl apply -f deploy/k8s/25-db-init-job.yaml
   ```
6. **Application Microservices (Helm Releases):** Deploy each service as an independent Helm release using the shared chart:
   ```bash
   # Deploy order: auth -> report -> notification -> analytics -> routing -> image -> gateway -> frontend
   for svc in auth report notification analytics routing image gateway frontend; do
     helm upgrade --install "${svc}" deploy/helm/civic-service \
       -n civic-app \
       -f deploy/helm/values/_common.yaml \
       -f "deploy/helm/values/${svc}.yaml" \
       --set image.tag="<commit-sha>"
   done
   ```
7. **Ingress and Certificates:**
   ```bash
   kubectl apply -f deploy/k8s/cert-manager/clusterissuers.yaml
   kubectl apply -f deploy/k8s/30-ingress.yaml
   ```

---

## 3. Validation and C2 Container Command

Manifests are validated for schema correctness (Kubernetes v1.35.0 strict), chart linting, and policy constraints via `.github/scripts/check-k8s.sh`.

### Exact C2 Container Command:
```bash
docker run --rm \
  -v D:\Semester_7\CNA\project\civic-issue-tracker:/repo:ro \
  -v D:\Semester_7\CNA\project\civic-issue-tracker\.local\bin-linux:/bin-linux:ro \
  -w /repo \
  -e PATH=/bin-linux:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55 \
  sh .github/scripts/check-k8s.sh
```

---

## 4. Verified Tools and Checksums

Pinned binary releases (at least 14 days old, verified via publisher SHA-256):

- **Helm `v4.3.0`** (Published: 2026-09-09T22:19:58Z):
  - Windows (`helm.exe`): `304ea163cce4d9ad14e189c01846c6a34de9cfdfe48536ae54b2e8ba7884e67c` (PASS)
  - Linux (`helm`): `86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb` (PASS)
- **Kubeconform `v0.8.0`** (Published: 2026-06-04T20:02:51Z):
  - Windows (`kubeconform.exe`): `e3f56102bcf4f50b034a567e2482a1c5330799983ddd655952310211aef73d93` (PASS)
  - Linux (`kubeconform`): `9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883` (PASS)

---

## 5. Verified only at cluster time (Prompts 6-7)

The following items cannot be fully verified via static render checks and are scheduled for cluster runtime validation:

- Traefik pod label and ingress class name `traefik`.
- HTTP-to-HTTPS redirect and `TRUST_PROXY` hop count behind Traefik.
- Client IP preservation behind ServiceLB.
- Data-store pod users and volume ownership on `local-path` storage.
- SeaweedFS and RabbitMQ runtime behavior under the restricted NetworkPolicies.
- HPA scaling behavior under synthetic load with 50m CPU requests.
- Actual pod memory usage vs configured limits.
- Image service bucket creation: Image service creates `civic-incoming` and `civic-images` buckets idempotently on startup (`services/image/app/storage.py:36-55`); verify S3 connectivity and bucket creation at cluster time.

# 06: Kubernetes Design (k3s)

> **Status:** Approved · **Last updated:** 2026-10-09
> Kubernetes is worth **2 of 20 marks**.

---

## 1. Cluster

- **k3s on a single VM** (server and workloads on the same node).
- k3s bundles CoreDNS, **metrics-server** (so autoscaling works with no extra install), a **local-path storage provisioner**, and a **NetworkPolicy controller**.
- **Ingress: k3s's bundled Traefik** (not NGINX Ingress). It saves memory and setup and still handles routing, TLS and redirects.
- **cert-manager** with Let's Encrypt provides certificates.

## 2. Namespaces

| Namespace | Contents |
|---|---|
| `civic-app` | The 8 application services |
| `civic-data` | PostgreSQL, RabbitMQ, Redis, SeaweedFS |
| `monitoring` | Prometheus, Grafana |
| `cert-manager` | Certificate management |
| `civic-staging` (optional) | A copy of the app, only if resources allow |

## 3. Workloads and replicas

| Workload | Kind | Replicas | Autoscale (HPA, CPU) |
|---|---|---|---|
| Frontend, Gateway, Auth, Report | Deployment | 2 | Gateway and Report: 2 to 3 |
| Image | Deployment | 1 | 1 to 2 |
| Routing, Notification, Analytics & Audit | Deployment | 1 | No |
| PostgreSQL, RabbitMQ, Redis, SeaweedFS | StatefulSet | 1 each | No |

**Honest limits:**
- On a single node, extra replicas protect against pod crashes and give zero-downtime rollouts, **not** against the VM failing.
- Single-instance data stores are single points of failure. Accepted at this scale; backups are the mitigation.
- Data stores use **official upstream images and our own small manifests**, not heavy operators that would use too much memory.
- Autoscaling on queue depth would need KEDA. It stays **Optional**. CPU-based HPA covers the approved requirement.

## 4. Configuration and secrets

- **ConfigMaps** per service for non-secret settings.
- **Secrets** for database passwords, the JWT private key and email credentials. Never baked into images, never committed in plain text.
- **Sealed Secrets:** secrets are encrypted so the encrypted form lives safely in the public repo. Only the cluster can decrypt them.

## 5. Ingress and TLS

- `/` goes to the frontend. `/api/` goes to the gateway. Everything else stays private.
- Automatic HTTPS from Let's Encrypt (use its **staging issuer first** to avoid rate limits). HTTP redirects to HTTPS.
- RabbitMQ, the storage console and Grafana are **not publicly exposed**. Reach them with port-forwarding or an IP-restricted route.

## 6. Health and rollouts

- **Startup, liveness and readiness probes** on every service using `/healthz` and `/readyz`.
- **Rolling updates** with zero unavailable pods and one surge pod. Graceful shutdown on SIGTERM and a short pre-stop delay.
- **PodDisruptionBudgets** on the 2-replica services.
- **Resource requests and limits on every pod.** Starting values (to be tuned in Phase 3): about 50m CPU and 128 Mi memory requests for Node services.

## 7. Storage and backups

- Persistent volumes (local-path) for Postgres, RabbitMQ, SeaweedFS and Prometheus.
- A nightly **backup CronJob** (`pg_dump` per database plus the object store) with a **tested restore**. Backups on the same VM are not a real backup, so copying them off-VM is decided in Phase 4.

## 8. Network and pod security

- **Default-deny NetworkPolicies** in both app namespaces, then explicit allows:
  - ingress to frontend and gateway
  - gateway to services
  - services to RabbitMQ
  - only Image to object storage
  - only Notification to external email
  - DNS for everyone
- Pods run **non-root with a read-only filesystem, all capabilities dropped and the default seccomp profile**.
- Each service gets its own **ServiceAccount** with the API token disabled unless needed.
- `civic-app` enforces the Kubernetes **restricted** Pod Security Standard.

## 9. Packaging and deployment

- **Helm: one shared chart** for all application services, with a small values file per service, deployed as one Helm release per service (D-052). Data stores and infrastructure get their own simple manifests.
- **Deployment happens through CI/CD** (`helm upgrade --install --atomic` from GitHub Actions, see `08`).
- **Argo CD / GitOps is not planned**, because its memory cost is not justified.

---

## Deferred decisions

| Decision | Settle in |
|---|---|
| Final resource requests and limits per workload (measured) | Phase 3 |
| Whether `civic-staging` is created | Phase 3 / Phase 4 |
| Helm chart values schema and naming conventions | Phase 3 |
| Backup destination off the VM | Phase 4 |
| HPA thresholds (target CPU %, min/max) after load testing | Phase 4 |
| Prometheus and Grafana retention and scrape settings | Phase 4 |
| How operators reach RabbitMQ, SeaweedFS and Grafana | Settled: `kubectl port-forward` (D-052) |
| Local Kubernetes rehearsal tool | Settled: none locally (D-051); kind runs in CI (D-053) |

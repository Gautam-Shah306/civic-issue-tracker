# 02: Non-Functional Requirements

> **Status:** Approved · **Last updated:** 2026-10-09
> **Scope rule:** implement **[Core]** and **[Should]**. **[Optional]** stays open for later.
> **Cost rule (overrides everything):** keep everything within **free-tier resources**. Paid resources are a **last resort**.

Numeric targets below are testable and are proven in Phase 4 (see `11`).

---

## 1. Performance

| ID | Requirement | Tier |
|---|---|---|
| PERF-01 | Page loads and API reads (list, detail) respond in under **500 ms at the 95th percentile** under normal load | Core |
| PERF-02 | Report submission returns an acknowledgement in under **2 seconds**; image processing is **asynchronous** so the citizen is never blocked | Core |
| PERF-03 | The public map and list views load in under **3 seconds**, using pagination and bounding-box queries, not full data dumps | Core |
| PERF-04 | Image thumbnails are ready within about **10 seconds** of upload | Should |
| PERF-05 | Caching of hot reads (public issue list, statistics) | Should |

## 2. Scalability

| ID | Requirement | Tier |
|---|---|---|
| SCAL-01 | Every service is **stateless** so it can scale horizontally behind a load balancer | Core |
| SCAL-02 | Services scale **independently** (for example Image separate from Auth) | Core |
| SCAL-03 | Autoscaling on CPU (Kubernetes HPA) | Should |
| SCAL-04 | Demonstration load: about **100 concurrent users** and about **50 report submissions per minute**, proven with a load test | Should |
| SCAL-05 | Database read replicas or sharding | Optional |

## 3. Availability and reliability

| ID | Requirement | Tier |
|---|---|---|
| AVL-01 | No single service failure takes down the whole platform (fault isolation) | Core |
| AVL-02 | At least **2 replicas** of critical services (gateway, auth, report intake, frontend) | Core |
| AVL-03 | Liveness and readiness probes on every service | Core |
| AVL-04 | Automatic restart of failed containers | Core |
| AVL-05 | Target availability of **99%** for the demo, with rolling updates so deployments cause no downtime | Should |
| AVL-06 | Retries with backoff and timeouts on inter-service calls, plus circuit breakers | Should |
| AVL-07 | Graceful degradation: if Notification or Image is down, reports are still accepted and processed later | Core |

> **Honest limit:** the platform runs on a single VM. Extra replicas protect against pod crashes and give zero-downtime rollouts, but **not** against the VM failing. This is accepted at this scale.

## 4. Data consistency and integrity

| ID | Requirement | Tier |
|---|---|---|
| DAT-01 | Each service **owns its own data store**; no other service reads it directly (database per service) | Core |
| DAT-02 | **Eventual consistency** between services via events is acceptable; status changes within one service are transactional | Core |
| DAT-03 | **Idempotent** event handlers and request handling, so retries and duplicates never create duplicate reports or notifications | Core |
| DAT-04 | Reliable event delivery: message broker with acknowledgements and a dead-letter queue | Should |
| DAT-05 | Valid status transitions are enforced in **one place only** (the Report service) | Core |

## 5. Security

| ID | Requirement | Tier |
|---|---|---|
| SEC-01 | Passwords hashed with a strong algorithm (**argon2**), never stored in plain text | Core |
| SEC-02 | Short-lived JWT access tokens with role-based authorization checked at the gateway **and** in each service | Core |
| SEC-03 | **HTTPS** everywhere on the public URL | Core |
| SEC-04 | Input validation and sanitization against injection and XSS | Core |
| SEC-05 | Upload restrictions on file type and size, plus content checks | Core |
| SEC-06 | **Secrets kept out of code and images** (environment variables, Kubernetes Secrets, Sealed Secrets) | Core |
| SEC-07 | Rate limiting at the gateway | Should |
| SEC-08 | Principle of least privilege for service accounts and database users | Should |
| SEC-09 | Network policies restricting which services can talk to which | Should |
| SEC-10 | Privacy: no personal data on the public view; EXIF location data stripped from stored images | Core |
| SEC-11 | Security headers and CORS configured correctly | Should |

## 6. Observability

| ID | Requirement | Tier |
|---|---|---|
| OBS-01 | Centralized, structured logs with a **correlation ID** passed across services | Core |
| OBS-02 | Metrics per service (request rate, error rate, latency) | Should |
| OBS-03 | Dashboards (Prometheus and Grafana) | Should |
| OBS-04 | Alerts on high error rate or service downtime | Optional |
| OBS-05 | Distributed tracing | Optional |

## 7. Maintainability and modularity

| ID | Requirement | Tier |
|---|---|---|
| MNT-01 | Loose coupling between services through well-defined APIs and events | Core |
| MNT-02 | Consistent API conventions and versioned endpoints (`/api/v1/...`) | Core |
| MNT-03 | Automated unit and integration tests in the pipeline, minimum **60% coverage** on core logic | Should |
| MNT-04 | Linting and code formatting enforced in CI | Should |
| MNT-05 | Configuration externalized per environment (12-factor style) | Core |
| MNT-06 | Clear documentation: README, architecture diagram and OpenAPI specs | Core |

## 8. Deployability and portability

| ID | Requirement | Tier |
|---|---|---|
| DEP-01 | Every service ships as a Docker image with small, reproducible, versioned builds | Core |
| DEP-02 | One-command local setup (Docker Compose) for development | Core |
| DEP-03 | Fully automated build, test and deploy via CI/CD | Core |
| DEP-04 | Environment provisioned reproducibly through Infrastructure as Code | Core |
| DEP-05 | Zero-downtime deployments (rolling updates) with simple rollback | Should |
| DEP-06 | Separate dev and production environments | Should |

## 9. Data management

| ID | Requirement | Tier |
|---|---|---|
| DMG-01 | Regular automated database backups with a tested restore procedure | Should |
| DMG-02 | Image storage in object storage, separate from the database | Core |
| DMG-03 | Data retention policy (how long closed reports stay public) | Optional |

## 10. Usability and accessibility

| ID | Requirement | Tier |
|---|---|---|
| UX-01 | Responsive design that works well on mobile phones | Core |
| UX-02 | Simple report flow completed in a few steps | Core |
| UX-03 | Basic accessibility: readable contrast, labels, keyboard navigation | Should |
| UX-04 | Clear error and empty-state messages | Core |
| UX-05 | Multi-language support | Optional |

## 11. Compliance and operational

| ID | Requirement | Tier |
|---|---|---|
| OPS-01 | An audit trail that cannot be modified by the users it records | Core |
| OPS-02 | Timestamps stored in **UTC**, displayed in local time (IST) | Core |
| OPS-03 | Cost kept within free-tier or low-cost limits for hosting | Core |

---

## Deferred decisions

| Decision | Settle in |
|---|---|
| Exact CPU and memory requests and limits per service | Phase 3 (measure on local k3s) |
| Final numeric targets after measurement (adjust if the free VM cannot meet them) | Phase 4 |
| Backup destination off the VM | Phase 4 |
| Alerting rules (if OBS-04 is taken up) | Optional, later |

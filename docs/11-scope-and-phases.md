# 11: Scope and Phases

> **Status:** Approved with updates · **Last updated:** 2026-10-14
> **Team:** one person. **Timeline:** none fixed ("we go as we go"). The plan is ordered so every phase leaves something working and demonstrable, and the riskiest, time-limited parts come last.

---

## 0. v1 and v2 (D-039)

Phases 2 to 5 below describe the full scope; v1 delivers their Core parts in the cycles above; the rest is v2.

### 10-cycle v1 delivery plan

| Cycle | Focus | Scope |
|---|---|---|
| (1) | Auth | Auth service (register, login, refresh, logout, me, JWT, user.created event) [done] |
| (2) | Gateway + Report | Gateway reverse proxy and Report service (submit, mine, status lifecycle, PostGIS spatial queries, outbox events) |
| (3) | Notification + Analytics & Audit | Notification (email via Mailpit) and Analytics & Audit read side and audit log |
| (4) | Python base + Image + Routing | Python base image, Image processing (SeaweedFS), Routing (wards, categories, departments) |
| (5) | Web Frontend + backend gaps | Responsive web frontend plus backend gaps (officer creation, user activation, seed data) |
| (6) | Local Kubernetes | Shared Helm chart, probes, 2 replicas on critical services, CPU autoscaling, default-deny network policies, Sealed Secrets, Traefik |
| (7) | Pipeline and DevSecOps | GHCR publish, Syft and Grype, OSV-Scanner, Hadolint, CodeQL, Checkov, automated deploy, post-deploy smoke, a short load run showing scale-up |
| (8) | Terraform and GCP | VM, k3s, DNS and TLS, first pipeline deploy; cloud account created |
| (9) | Go-live finish | Smoke on the public URL, seed data, README, architecture diagram, demo script |
| (10) | Buffer | Buffer cycle for polish, fixes, and demonstration preparation |

### Deferred to v2

v2 = duplicate detection, comments, upvotes, moderation and flagging, password reset, SLA escalation, priority scoring, assignment to a specific officer, multiple photos, in-app notifications, edit or cancel, statistics page, heatmap, exports, Prometheus and Grafana, backups with a restore test, the full load test, the kind integration test in CI, ZAP, Cosign signing, SARIF upload, API aggregation. The frontend is a responsive web app only (no native or mobile app). The cloud account is created at the end of v1 (cycle 8), earlier than planned in D-013, so the credit clock starts sooner; the VM is stopped between demos.

## 1. Build strategy

- **Walking skeleton first:** one thin end-to-end path (register, submit a report, an event flows, an email appears), then widen it.
- **Vertical slices, not layers:** a feature is finished only when it has code, tests, a Dockerfile, a contract entry and green pipeline checks.
- **Cloud last:** everything is built and proven locally first. The GCP account is created only in Phase 5.
- **Work strictly in phase order.** Do each service's platform work (Docker, CI, Helm) as part of its slice rather than leaving it all to the end.
- **Data is synthetic**, including wards (see section 7).

## 2. Phases (in order, no dates)

| Phase | Goal | Exit criteria |
|---|---|---|
| **0. Foundations** | Public GitHub monorepo, folder layout, `/docs`, `/contracts`, `CODE_STYLE.md`, `.gitignore`, `.gitattributes` (LF), conventions, Docker Compose with Postgres/PostGIS, RabbitMQ, Redis, SeaweedFS and Mailpit, CI skeleton with secret scanning | `docker compose up` starts the infrastructure; CI runs green on the empty services |
| **1. Walking skeleton** | Gateway, Auth, Report (submit and basic status), Notification, minimal frontend, a Dockerfile and CI per service | A citizen registers, submits a report, and an email appears in Mailpit through a real event |
| **2. Core features** | Image processing, Routing and Assignment (wards, departments, categories), full status lifecycle, officer and admin dashboards, public map and list, Analytics and Audit | Every **[Core]** functional requirement works locally |
| **3. Platform and security** | Shared Helm chart, local k3s or kind deployment, probes, autoscaling, network policies, Sealed Secrets, kind integration test in CI, all DevSecOps gates | The whole system deploys to a local Kubernetes cluster through the pipeline, with scans green |
| **4. Should features and proof (v2)** | Duplicate detection, SLA escalation, comments, upvotes, password reset, rate limiting, monitoring dashboards, backups, API docs, load test | **[Should]** items done, non-functional targets measured, memory fits the 8 GB budget |
| **5. Go-live** | Create the GCP account, run Terraform (manual apply), bootstrap the cluster, DNS and TLS, deploy through the pipeline, smoke tests, demo rehearsal, README and architecture diagram | Public HTTPS link works, then stays live for about a month before `terraform destroy` |

Phases 3 and 4 can overlap, but Phase 3 comes first because it secures most of the marks.
**Do not start phase N+1 until the exit criteria of phase N are verified.**

## 3. Marks coverage by phase

| Area | Marks | Demonstrable from |
|---|---|---|
| Docker | 4 | Phase 1 |
| Microservices | 3 | Phase 2 |
| CI/CD | 3 | Phase 0, complete in Phase 3 |
| DevSecOps | 2 | Phase 0, complete in Phase 3 |
| Kubernetes | 2 | Phase 3 (locally) |
| Cloud or local hosting | 2 | Phase 3 (local), Phase 5 (cloud) |
| Infrastructure as Code | 2 | Code written and validated earlier, applied in Phase 5 |
| Public link | 2 | Phase 5 |

Roughly 16 of the 20 marks are demonstrable locally before any cloud account exists. If the cloud step ran into trouble, a local cluster behind a tunnel would still cover part of the remaining marks.

## 4. Working method (solo, with Antigravity)

- Claude (in the Claude Project) writes the prompts, reviews the pasted results, supplies git commands, commit messages and small manual doc edits.
- Antigravity does the coding. The developer runs everything and pastes results back.
- Full protocol and the prompt template are in `PROJECT-INSTRUCTIONS.md`.
- There is no second human reviewer, so the chat review of each diff and result is the review step (see `08`, section 6).

## 5. Scope control

**Definition of done for any feature:** tests pass, it validates against the contract, it builds as a hardened image, health endpoints work, and the pipeline's scans are green.

**If time runs short, cut in this order** (first to go on top). All are approved **[Should]** items. Core items are never cut. The developer does not expect to need this.

1. Public statistics page (PUB-05), and rating or feedback extras (CIT-05, already Optional)
2. Multiple photos per report (RPT-04), and edit or cancel before assignment (CIT-03)
3. Comments on reports (CIT-04), and moderation or flagging (MOD-01)
4. In-app notifications (NTF-04); email stays
5. Assignment to a specific officer (RTE-05); department-level assignment stays

The 8-service architecture stays regardless, but a service can be built thin. For example, Analytics and Audit could start as just an audit log plus basic counts.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Scope is large for one person | Phase gates, the cut order above, thin services |
| The VM runs out of memory | Measure on local k3s in Phase 3 with real limits, long before the cloud |
| Cloud sign-up or free-tier terms change | Re-check the offer right before sign-up (`10`, section 7); keep the local and Oracle fallbacks |
| Credits run out early | Create the account late, stop the VM between sessions, budget alerts |
| Email limits on free providers | Mailpit for development; a free-tier email service only for the live demo |
| Scanner or tool becomes unsafe or unmaintained (as happened with MinIO and Trivy) | Pin versions, re-verify tool status before Phase 3, keep alternatives noted in the decision log |
| Windows-specific issues (line endings, paths, Docker runtime) | `.gitattributes` with LF from Phase 0; confirm Docker runtime and shell in Phase 0 |

## 7. Synthetic data

- **Wards:** a generated set of simplified polygons (for example a grid of rectangles with names and codes) stored as GeoJSON and loaded into the Routing service's PostGIS tables. Real boundaries are **not** used.
- **Reference data:** departments (Roads, Sanitation, Electricity and similar), categories mapped to departments, SLA values. Reference data is seeded by SQL migrations (D-045), and demo users and reports come from a small script in cycle 5 or 9.
- **Users:** seeded citizens, officers and an admin for demos (clearly fake credentials, never real ones, and never committed if they could be mistaken for real secrets).
- **Reports:** generated reports across wards, categories and statuses for dashboards, maps and the load test.
- A single repeatable **seed script** (idempotent) produces all of this.

## 8. Demo script and definition of "project done"

**Demo script:**
1. A citizen registers and submits a report with a photo.
2. The image is processed and the report is routed to the right department.
3. An officer updates the status.
4. The citizen is notified, and the public map shows the issue.
5. Show a pipeline run with its scan results, the Terraform code, and Kubernetes scaling under load.
6. Open the live public link.

**The project is done when:** all Core and Should requirements work, all 20 marks are demonstrable, the live link works, and the README and architecture diagram are complete.

---

## Deferred decisions

| Decision | Settle in |
|---|---|
| Sub-steps and ordering inside each phase (planned per phase as it starts) | At the start of each phase |
| Ward grid size, names and codes; department and category lists | Phase 2 |
| Load test tool and scenarios | Phase 4 |
| README structure and architecture diagram format | Phase 5 |

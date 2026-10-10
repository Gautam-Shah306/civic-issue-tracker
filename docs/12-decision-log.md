# 12: Decision Log

> **Status:** Living document · **Last updated:** 2026-10-10
> Every decision and every change of direction is recorded here with its reason. Add a new entry whenever something changes, and update the affected document(s). Never silently overwrite an old decision: add a new entry that supersedes it.

**Entry format:** ID, decision, alternatives considered, reason, status, documents affected.
**Status values:** `Approved`, `Superseded by D-xxx`, `Proposed` (awaiting confirmation).
**Date:** all entries below were made during the design discussion (October 2026).

---

| ID | Decision | Alternatives / what it replaced | Reason | Status | Docs |
|---|---|---|---|---|---|
| D-001 | Build the **Civic Issue Tracker** as the DevOps project | Other app ideas considered earlier | Fits the assessment criteria (microservices, Docker, IaC, DevSecOps, public link) | Approved | 00 |
| D-002 | Decide everything **one topic at a time** before any implementation | Starting to code early | Avoids rework; design first | Approved | 00 |
| D-003 | Functional requirements approved with tiers. **Implement Core and Should; keep Optional open** for later | Implementing Core only | Wider scope while keeping a defined fallback | Approved | 01 |
| D-004 | Follow proper **System Design** principles throughout | , | Quality bar for the project | Approved | all |
| D-005 | Non-functional requirements approved. **Cost rule: free-tier first, paid only as last resort** | , | Student project with no budget | Approved | 02, 10 |
| D-006 | **Eight services**, with **Analytics & Audit kept separate** | Merging Analytics & Audit into Report to save resources | Read side isolated from intake; audit log append-only (OPS-01) | Approved | 03 |
| D-007 | Database per service; REST for synchronous calls; events for workflows; **outbox pattern**; choreography | Orchestration; shared database | Loose coupling, reliability, fits requirements | Approved | 03 |
| D-008 | Broker: **RabbitMQ** | Redis Streams, NATS | Acks, retries and DLQ are built in, so reliability is configuration, not custom code | Approved | 04 |
| D-009 | **Polyglot, two languages: Node.js/TypeScript and Python.** Go removed | Single language (Node only); three languages including Go | Matches each service to its job; two toolchains is the limit the developer accepted | Approved | 04, 05 |
| D-010 | Services share **contracts, not code** (`/contracts`) | Shared monorepo packages | Python and Node cannot share code | Approved | 04, 08 |
| D-011 | **Git** (VCS), **GitHub** (SCM), **public monorepo** | Private repo | Public repo keeps GHCR and Actions free | Approved | 05, 08 |
| D-012 | **k3s on a single VM** | Managed Kubernetes (GKE, EKS) | Cheaper and fits the free-tier rule; still conforming Kubernetes | Approved | 06, 10 |
| D-013 | Cloud hosting: **GCP Free Trial primary; AWS Free Plan alternative; Oracle Always Free emergency backup only.** Cloud account created **last** | Oracle as primary (earlier proposal) | Only about one month live and about 100 requests needed; GCP's $300 over 90 days fits; Oracle has capacity and size uncertainty | Approved | 10 |
| D-014 | **Object storage: SeaweedFS** replaces **MinIO** | MinIO (original choice); Garage; RustFS | MinIO stopped publishing images in Oct 2025, entered maintenance in Dec 2025, archived Apr 25, 2026 | Approved | 04, 06 |
| D-015 | Ingress: **k3s bundled Traefik** | NGINX Ingress (earlier proposal) | Saves memory and setup | Approved | 06 |
| D-016 | Secrets: **Sealed Secrets** | Plain Kubernetes Secrets; SOPS | Safe to store encrypted secrets in a public repo | Approved | 06, 09 |
| D-017 | **One shared Helm chart** for app services; **no Argo CD** | Per-service charts; GitOps | DRY for 8 similar services; Argo CD memory cost not justified | Approved | 06, 08 |
| D-018 | Registry: **GHCR** | Google Artifact Registry | Free for public images, next to the code | Approved | 05 |
| D-019 | Docker target platform **`linux/amd64`** (arm64 only if needed) | ARM-only (earlier note, for Oracle) | GCP and AWS VMs are x86 | Approved | 05 |
| D-020 | Terraform: **local state** (single operator), remote bucket as fallback; **manual approval-gated apply**; **no public SSH (IAP)**; **GCP module only** for now | Remote state bucket; auto-apply; AWS module now | Tiny infrastructure and a solo operator; avoids risk on a credit-funded account | Approved | 07 |
| D-021 | CI/CD: GitHub Actions; deploy via **OIDC + IAP tunnel** with `helm --atomic`; **automatic deploy on merge to `main`**; kind integration test; trunk-based branching | Self-hosted runner; public Kubernetes API; manual deploy approval | No stored cloud keys, no open ports; rewards automation | Approved | 08 |
| D-022 | **Solo-developer adjustment to branch protection:** required approvals set to **0**; pull request and all required status checks stay mandatory; CODEOWNERS kept but not enforced; chat review acts as the review step | "One required review" (approved when a team was assumed) | GitHub does not let an author approve their own pull request, so one required review is impossible for one person | Superseded by D-030 | 08, 09 |
| D-023 | DevSecOps toolset: **Gitleaks + GitHub secret scanning, OSV-Scanner + Dependabot, CodeQL, Grype + Syft, Hadolint, Checkov, OWASP ZAP baseline**; **Cosign signing and verification at deploy** | **Trivy** (original idea) | Trivy's GitHub Action and a release were compromised in March 2026 | Approved | 09 |
| D-024 | Scanner policy: **fail on any secret and on Critical/High with a fix available**; time-limited exceptions; Grype database staleness check | Looser thresholds | Strong gates with an escape hatch that expires | Approved | 09 |
| D-025 | Team is **one person**; no fixed timeline; **six phases in order, cloud last**; **Should-item cut order** approved (not expected to be needed) | Three-person split assumed earlier | Reality of the project | Approved | 11 |
| D-026 | **Synthetic data**, including generated wards | Real ward boundaries | No real ward data available | Approved | 11 |
| D-027 | **Workflow:** Claude Project holds these docs as the source of truth; **Antigravity** does the coding from Claude-written prompts; the developer runs everything, supplies git commands and pastes results back; small doc edits done manually | Other workflows | Developer's chosen working method | Approved | PROJECT-INSTRUCTIONS |
| D-028 | Add **`PROGRESS.md`** for continuity across chats, and create **`CODE_STYLE.md`** in Phase 0 | , | Project knowledge is static between uploads; prompts require a code style reference | Approved | PROJECT-INSTRUCTIONS, 11 |
| D-029 |   **Bootstrap exception**: until branch protection is enabled (once the CI skeleton is green, end of Phase 0), the developer commits and pushes directly to main. After that, PR plus required checks only, no direct pushes | Protection from the first commit | Required status checks cannot exist before CI does | Superseded by D-030 | 08 |
| D-030 | **No pull requests. The solo developer commits and pushes directly to `main` for the whole project.** No branch protection and no required reviews. CI runs on every push to `main`. Image publish, signing and deploy run only if every check, scan and the integration test passed **on that same commit**. Review happens in the Claude chat on the `git diff` **before** commit. Gitleaks pre-commit is mandatory. The `pull_request` trigger stays for outside contributors' PRs (never `pull_request_target`) | PR plus required checks and 0 approvals (D-022); direct pushes only during bootstrap (D-029) | Solo developer: a PR adds no review value, and GitHub cannot require self-approval. Gates still stop bad commits from being published or deployed | Approved | 07, 08, 09, 11, PROJECT-INSTRUCTIONS |

---

## Open items carried forward

- Re-verify volatile facts (free-tier terms, tool status) before Phase 3 and again before Phase 5.
- All "Deferred decisions" sections in documents `01` to `11`.

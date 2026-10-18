# PROGRESS: Civic Issue Tracker

> **Last updated:** 2026-10-18
> Updated manually by the developer from lines supplied by Claude after each verified step.
> Paste the **Status** block into a new chat if the uploaded copy may be stale.

## Status

- **Current phase:** Phase 1, Walking skeleton (in progress)
- **Last verified step:** Prompt 1: backend completion, admin bootstrap, seed & e2e (D-048)
- **Design baseline:** approved, documents `00` to `12` dated 2026-10-09
- **Cloud account:** not created (by design; created in Phase 5)
- **Next action:** Prompt 3: frontend B (staff and admin views)

## v1 plan (D-039)

Phase checklists below describe the full scope; D-039 supersedes them where they differ.

- [x] Cycle 1: Auth (committed)
- [x] Cycle 2: Gateway + Report (D-040)
- [x] Cycle 3: Notification + Analytics & Audit (Phase 1 exit test verified (local), D-041, D-042)
- [x] Cycle 4: Python base + Image + Routing (D-044, D-045, D-046, D-047)
- [ ] Cycle 5: Web Frontend + backend gaps
- [ ] Cycle 6: Local Kubernetes
- [ ] Cycle 7: Pipeline and DevSecOps
- [ ] Cycle 8: Terraform and GCP
- [ ] Cycle 9: Go-live finish
- [ ] Cycle 10: Buffer

## Phase checklist

### Phase 0: Foundations
- [x] Public GitHub repo created; monorepo layout in place
- [x] `/docs` populated with documents `00` to `12`, `PROJECT-INSTRUCTIONS.md`, `PROGRESS.md`
- [x] `.gitignore` (including `*.tfstate*`, real `*.tfvars`, env files) and `.gitattributes` (LF)
- [x] `CODE_STYLE.md` created
- [x] D-030 recorded: direct pushes to `main`, no pull requests, no branch protection
- [x] Gitleaks pre-commit hook (pinned v8.30.1, D-031) installed and verified; GitHub secret scanning and push protection on
- [x] Docker runtime and shell confirmed on the Windows machine
- [x] Docker Compose infrastructure runs (Postgres/PostGIS, RabbitMQ, Redis, SeaweedFS, Mailpit)
- [x] CI skeleton green (first run: secret scan, Compose validation, repo hygiene; D-034); Gitleaks and secret scanning on
- [x] Dependabot: alerts and security updates enabled in repo settings; policy settled (D-032); `docker-compose` and `github-actions` entries committed
- [x] Phase 0 exit check passed: Compose infrastructure healthy, CI green, secret scanning on (D-035)

### Phase 1: Walking skeleton

- [x] Slice 1: event and error contracts, topology document, `db-init` (D-036)
- [x] Slice 1b: Node service template, reusable workflow, contract check in CI
- [x] Slice 2: Auth service (register, login, JWT, `UserCreated`)
- [x] Slice 3: Gateway (JWT verification, routing, correlation ID, rate limit)
- [x] Slice 4: Report service (submit, my reports, outbox, `ReportSubmitted`, status transitions table)
- [x] Slice 5: Notification service (idempotent consumer, email to Mailpit)
- [ ] Slice 6: minimal frontend (register, login, submit, list)
- [ ] Dependabot entries added with each first manifest (`npm` and `pip` per service)
- [x] Citizen registers, submits a report, email appears in Mailpit via a real event

### Phase 2: Core features
- [ ] Image, Routing and Assignment, status lifecycle, dashboards, public map and list, Analytics and Audit
- [ ] Every Core functional requirement works locally

### Phase 3: Platform and security
- [ ] Shared Helm chart; local k3s or kind deployment
- [ ] Probes, HPA, network policies, Sealed Secrets
- [ ] kind integration test in CI; all DevSecOps gates green
- [ ] Re-verify tool status (supply chain, maintenance state)

### Phase 4: Should features and proof
- [ ] Should features done
- [ ] Load test run; non-functional targets measured; memory fits 8 GB
- [ ] Backups and restore tested; monitoring dashboards

### Phase 5: Go-live
- [ ] Hosting checklist in `10` re-verified; GCP account created
- [ ] Terraform applied manually; cluster bootstrapped; DNS and TLS working
- [ ] Dependabot `terraform` entry added with the first `.tf` file (earlier than Phase 5 if the code is written earlier)
- [ ] Deployed through the pipeline; smoke tests pass
- [ ] README and architecture diagram complete; demo rehearsed
- [ ] Live for about a month, then `terraform destroy`

## Open items

- All "Deferred decisions" sections in documents `01` to `11`
- Raise the Docker Desktop VM memory limit (currently 3.757 GiB) before the Phase 3 local Kubernetes test
- Scan the pinned third-party images (D-033) with Grype in Phase 3
- Optional, later: verify the CI failure paths on GitHub with a throwaway branch and `workflow_dispatch`

## Log

| Date | Step | Result |
|---|---|---|
| 2026-10-09 | Design documents written | Baseline approved |
| 2026-10-10 | Repo created and cloned; D-030 recorded (direct pushes, no PRs) | Verified |
| 2026-10-10 | First commit pushed (layout, base config, docs; 35 files) | Verified |
| 2026-10-10 | Gitleaks v8.30.1 pre-commit hook installed; fake-token test blocked; clean commit passed | Verified |
| 2026-10-10 | Dependabot policy recorded (D-032); `docker-compose` entry live | Verified |
| 2026-10-10 | Compose infrastructure committed; five services healthy after a clean restart (D-033) | Verified |
| 2026-10-11 | CI workflow and check scripts committed; first run green (secret scan, Compose validation, repo hygiene) (D-034) | Verified |
| 2026-10-11 | Dependabot `github-actions` entry committed | Committed |
| 2026-10-11 | GitHub Actions repository settings confirmed by the developer | Verified |
| 2026-10-11 | Phase 0 exit check passed; Python-related deferred decisions moved to Phase 2 (D-035) | Verified |
| 2026-10-12 | Phase 1 kickoff decisions recorded (D-036) | Verified |
| 2026-10-12 | Slice 1b verified (contracts package, Node service template, reusable CI workflow; D-037) | Verified |
| 2026-10-13 | Slice 2: Auth service (register, login, refresh, logout, JWT, user.created) end to end in Compose (D-038) | Verified |
| 2026-10-13 | v1 cycle 2: Gateway + Report (D-040) | Verified |
| 2026-10-13 | v1 cycle 3: Notification + Analytics & Audit (Phase 1 exit test verified) (D-041) | Verified |
| 2026-10-14 | Cycle 3b: dependency repair and review fixes (D-042) | Phase 1 exit test verified (local) |
| 2026-10-14 | Cycle 3c: analytics CI race fix, notification timeout rule, zero-lint, grouped Dependabot (D-043) | Verified |
| 2026-10-14 | v1 cycle 4a: Python base + Routing + automatic assignment (D-044, D-045, D-046) | Verified |
| 2026-10-16 | v1 cycle 4b: Image service + photo pipeline (D-047) | Verified |
| 2026-10-18 | Prompt 1: backend completion, admin bootstrap, seed & e2e (D-048) | Verified |
| 2026-10-18 | Prompt 2: frontend A (foundation, design system, public views, auth, citizen journey) (D-049) | Verified |

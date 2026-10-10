# PROGRESS: Civic Issue Tracker

> Updated manually by the developer from lines supplied by Claude after each verified step.
> Paste the **Status** block into a new chat if the uploaded copy may be stale.

## Status

- **Current phase:** Phase 0, Foundations (in progress)
- **Last verified step:** Gitleaks pre-commit hook (blocks a fake token; clean commit passes)
- **Design baseline:** approved, documents `00` to `12` dated 2026-10-09
- **Cloud account:** not created (by design; created in Phase 5)
- **Next action:** Dependabot configuration, then Docker Compose infrastructure, then the CI skeleton

## Phase checklist

### Phase 0: Foundations
- [x] Public GitHub repo created; monorepo layout in place
- [x] `/docs` populated with documents `00` to `12`, `PROJECT-INSTRUCTIONS.md`, `PROGRESS.md`
- [x] `.gitignore` (including `*.tfstate*`, real `*.tfvars`, env files) and `.gitattributes` (LF)
- [x] `CODE_STYLE.md` created
- [x] D-030 recorded: direct pushes to `main`, no pull requests, no branch protection
- [x] Gitleaks pre-commit hook (pinned v8.30.1, D-031) installed and verified; GitHub secret scanning and push protection on
- [x] Docker runtime and shell confirmed on the Windows machine
- [ ] Docker Compose infrastructure runs (Postgres/PostGIS, RabbitMQ, Redis, SeaweedFS, Mailpit)
- [ ] CI skeleton green on empty services; Gitleaks and secret scanning on
- [ ] Dependabot: alerts and security updates enabled in repo settings; policy settled (D-032); ecosystem entries added with each first manifest

### Phase 1: Walking skeleton
- [ ] Gateway, Auth, Report, Notification, minimal frontend, each with Dockerfile and CI
- [ ] Citizen registers, submits a report, email appears in Mailpit via a real event

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
- [ ] Deployed through the pipeline; smoke tests pass
- [ ] README and architecture diagram complete; demo rehearsed
- [ ] Live for about a month, then `terraform destroy`

## Open items

- All "Deferred decisions" sections in documents `01` to `11`

## Log

| Date | Step | Result |
|---|---|---|
| 2026-10-09 | Design documents written | Baseline approved |
| 2026-10-10 | Repo created and cloned; D-030 recorded (direct pushes, no PRs) | Verified |
| 2026-10-10 | First commit pushed (layout, base config, docs; 35 files) | Verified |
| 2026-10-10 | Gitleaks v8.30.1 pre-commit hook installed; fake-token test blocked; clean commit passed | Verified |

# 08: CI/CD Pipeline

> **Status:** Approved (no pull requests for a solo developer, see section 6 and D-030) · **Last updated:** 2026-10-10
> CI/CD is worth **3 of 20 marks**. GitHub Actions does all the automation. Security scanners appear as pipeline stages (see `09`).

---

## 1. Pipeline overview

| Stage | Trigger | What happens |
|---|---|---|
| **CI** | Every push to `main` (and any outside contributor's pull request) | Lint, tests, contract checks, image build (no push), security scans |
| **Build and publish** | Push to `main` | Same checks, then build the image and push to GHCR tagged with the commit SHA |
| **Integration test** | Push to `main` | Install the whole system on a temporary Kubernetes cluster (kind) inside the runner and run smoke tests |
| **Deploy** | After the above succeed | Roll out to the k3s cluster with Helm, run a post-deploy smoke test, roll back automatically on failure |
| **Release** | Git tag `vX.Y.Z` | Version-tagged images and a GitHub Release |

GitHub-hosted runners on a public repository are free for standard usage, which fits the free-tier rule.

## 2. Workflow structure

- **Reusable workflows** per technology: `node-service`, `python-service`, `frontend`. Each service has a short wrapper workflow that calls the right one with its own path filter, so only changed services are built.
- Separate workflows: `infra-ci` (Terraform checks), `deploy`, `release`, and a weekly `scheduled-scan` (see `09`).
- `concurrency` groups cancel superseded runs and prevent two deploys at once.
- Docker layer caching keeps builds fast.

## 3. What each service's CI runs

- **Lint and format checks** (ESLint and Prettier for Node, Ruff for Python, plus Hadolint for Dockerfiles).
- **Unit tests**, then **integration tests** against real Postgres and RabbitMQ (service containers or Testcontainers), with a **60% coverage gate** on core logic (MNT-03).
- **Contract checks:** validate each service against the OpenAPI specs and event schemas in `/contracts`. **Fail the build on drift.**
- **Image build** with buildx for `linux/amd64`, then the image scan **before** any push.
- **Security gates** (secret, dependency, static analysis, image scans) run in the same pipeline. A failure stops the pipeline: nothing is published, signed or deployed from that commit (see `09`).

## 4. How the pipeline reaches the cluster

There is no public SSH and no public Kubernetes API.

| Option | Verdict |
|---|---|
| **GitHub Actions authenticates to GCP with OIDC, then runs the deploy over an IAP tunnel to the VM** | **Chosen.** No stored cloud keys, no open ports, free. Needs a firewall rule allowing only Google's IAP range on port 22 |
| Self-hosted runner on the VM | Rejected: costs memory, and on a public repo it risks untrusted code running on the server |
| Public Kubernetes API | Rejected: expands the attack surface for no benefit |

The deploy job connects, runs `helm upgrade --install --atomic` from the shared chart with the new image SHA, then exits. It first **verifies the image signature** with Cosign (see `09`).

## 5. Safe deployment

- **`--atomic` with a timeout:** a failed rollout reverts automatically. `helm rollback` is available manually.
- **Database migrations** run as Helm pre-upgrade hook Jobs and are **backward-compatible** (add first, remove later), because rolling updates briefly run old and new code together.
- **Post-deploy smoke test:** health endpoints plus a synthetic end-to-end check (submit a test report and confirm it reaches *Assigned*).
- **Immutable image tags** (commit SHA, plus SemVer on releases), never `latest`.
- **Deploy trigger: automatic on every push to `main`, but only if all checks, scans and the integration test passed on that same commit.** Atomic rollback and the smoke test are the safety net.

## 6. Branching and versioning

- **Trunk-based development, solo:** the developer commits and pushes directly to `main`. There are no pull requests of our own and no branch protection (D-030); Dependabot's update PRs are the one exception, merged from the GitHub UI after CI is green (D-032). Short-lived local branches are optional for risky changes, merged locally before pushing.
- **Review happens before commit:** the Claude chat reviews the `git diff` and verification output. There is no second human reviewer, so this is the review step.
- **Gitleaks pre-commit is mandatory** (a pinned binary run by `.githooks/pre-commit`, D-031) and GitHub push protection stays on, because a pushed secret is public immediately.
- **Conventional Commits** (`feat:`, `fix:`, `chore:` and so on) for a readable history.
- **Semantic versioning** for releases, first release tagged `v1.0.0`.

## 7. Public-repo safety rules (from day one)

- Use the `pull_request` trigger, **never `pull_request_target`**, so forked pull requests never get secrets.
- Require approval before workflows run for first-time outside contributors.
- Set minimal `permissions:` on every workflow, and **pin third-party actions to commit SHAs** (see `09`).
- Make GHCR packages **public** (a one-time setting).

## 8. Timing, given the late cloud sign-up

- **CI, build, publish and the kind integration test work from day one**, with no cloud account.
- **The deploy workflow is written early but tested only after the cloud sign-up** (Phase 5). Until then, deployment is rehearsed on a local k3s or kind cluster.

---

## Deferred decisions

| Decision | Settle in |
|---|---|
| Exact workflow filenames and reusable-workflow inputs | Phase 0 / Phase 1 |
| Path-filter rules per service (including shared `/contracts` changes triggering all affected services) | Phase 1 |
| How the smoke test authenticates and cleans up its test data | Phase 3 |
| Release notes format and when `v1.0.0` is cut | Phase 5 |
| Deploy-user permissions on the VM and the IAP-based deploy script | Phase 5 |

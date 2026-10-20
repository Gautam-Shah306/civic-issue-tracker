# 09: DevSecOps

> **Status:** Approved · **Last updated:** 2026-10-14
> DevSecOps is worth **2 of 20 marks**. The assessment names **image, dependency and secret scanning**. Those are the centrepiece, with extras that strengthen the story. All tools are free.

---

## 1. Tool choice, and why Trivy is not used

Trivy was the first idea and was **dropped** after research (verified 2026-10-09):

- On March 19, 2026, an attacker used stolen credentials to publish a malicious Trivy release (v0.69.4) and rewrote 76 of the 77 version tags of its GitHub Action so they delivered a credential stealer.
- The recommended defence is to pin GitHub Actions to full, immutable commit hashes instead of version tags.
- Trivy may be fine now, but a pipeline holding deployment access should use scanners without that recent history.

**Grype has its own catch:** its older database format stopped receiving updates in March 2026, and outdated versions kept running without any error. So the pipeline **pins a current version and fails the build if the vulnerability database is stale.**

## 2. Scanning stages

| Check | Tool | Runs | Catches |
|---|---|---|---|
| **Secret scanning** | **Gitleaks** (pre-commit hook plus CI on full history) and **GitHub secret scanning with push protection** (free on public repos) | Locally (pre-commit), and on every push | Keys, tokens, passwords committed by mistake |
| **Dependency scanning** | **OSV-Scanner** (Node and Python lockfiles) and **Dependabot** (update PRs and alerts) | Every push to `main`, plus weekly | Known vulnerable libraries |
| **Static analysis (SAST)** | **CodeQL** (GitHub-native, free on public repos, JS/TS and Python) | Every push to `main` | Injection flaws and unsafe patterns in our code |
| **Container image scanning** | **Grype**, with **Syft** generating an SBOM | Every build, before pushing to GHCR | Vulnerable OS packages and libraries in images |
| **Dockerfile linting** | **Hadolint** | Every push to `main` | Bad Dockerfile practices |
| **IaC and Kubernetes scanning** | **Checkov** on Terraform and rendered Helm manifests | Pushes touching `/infra` or `/deploy` | Insecure cloud and cluster configuration |
| **Dynamic scan (DAST)** | **OWASP ZAP baseline** against the system in the temporary kind cluster | On push to `main`, in the integration stage | Missing security headers, exposed endpoints, common web flaws |

All scans run on free GitHub runners, so they cost **no memory on the VM**. Results upload as SARIF to GitHub's **Security tab**, giving assessors a visible record.

## 3. Pass/fail policy

| Finding | Action |
|---|---|
| **Any secret** | **Fail** the build |
| **Critical or High vulnerability with a fix available** (images and dependencies) | **Fail** the build |
| **SAST errors, or Checkov failures on high-severity rules** | **Fail** the build |
| Medium, Low, or High with no fix available | Reported, does not block |

- **Exceptions** live in one reviewed allowlist file. Every entry needs a **reason and an expiry date**, so nothing is ignored forever.
- A failing gate stops the pipeline: nothing from that commit is published to GHCR, signed or deployed (see `08`, D-030).

## 4. Supply-chain protections

- **Pin every third-party GitHub Action to a full commit SHA.** Dependabot proposes updates to those pins, and `check-repo-hygiene.sh` fails CI if any `uses:` is not pinned (D-034).
- **Install scanner binaries at pinned versions and verify checksums**, not a latest tag.
- **Gitleaks runs as a pinned, checksum-verified binary** (v8.30.1 or later; earlier versions have CVE-2026-63728), never through `gitleaks-action`. The pre-commit hook in `.githooks/` runs it from `.local/bin` and fails closed if it is missing (D-031).
- **Sign images with Cosign** using GitHub's OIDC identity (free, no keys to store), and **verify the signature in the deploy job** before `helm upgrade`. The cluster then only runs images our pipeline built.
- **Attach the SBOM** to each release.
- **Minimal `permissions:`** on every workflow, and **no deployment secrets in scan jobs**.

## 5. Keeping scanning current

- **Weekly scheduled workflow** re-scans the published images, because new vulnerabilities appear after a build.
- **Dependabot weekly** for npm, pip, Docker base images, Docker Compose, GitHub Actions and Terraform providers. Policy (D-032): 7-day cooldown on version updates, minor and patch updates grouped into one grouped pull request across services (D-043), update PRs merged from the GitHub UI after CI is green. Major version bumps are decisions, not automation: they are ignored in `dependabot.yml` (D-038).

## 6. Secret handling and runtime security

These controls are specified elsewhere and listed here for completeness.

- **Secrets:** Sealed Secrets in the cluster (`06`), OIDC instead of stored cloud keys (`07`, `08`), nothing sensitive in images or Terraform state.
- **If a secret ever leaks:** **rotate it immediately** and treat it as compromised. Deleting the commit does not undo exposure on a public repo.
- **Cluster:** non-root, read-only containers, restricted Pod Security Standard, default-deny NetworkPolicies, HTTPS only (`06`).
- **Application:** argon2 password hashing, short-lived signed JWTs, input validation, gateway rate limiting, security headers (`02`).
- **Out of scope for now:** runtime threat detection (for example Falco), because of its memory cost. **Optional**, later.

## 7. Marks coverage

The three scans the assessment names (image, dependency, secret) are automated gates with visible results. SAST, IaC scanning, DAST, signing and SBOMs go beyond that.

---

## Deferred decisions

| Decision | Settle in |
|---|---|
| Pinned versions of the security tools | Settled in `.github/tools.lock` and `.github/checkov-requirements.txt` (D-054, D-056); Cosign and ZAP are v2 (D-039) |
| Allowlist entry format and expiry enforcement | Settled: `.github/security/vuln-allowlist.txt`, checked by `check-allowlist.sh` (D-054) |
| Staleness threshold for the Grype database check | Settled: 5 days (D-054) |
| ZAP baseline scope and rules to ignore | Phase 3 |
| Cosign verification identity settings (workflow and repo identity) | Phase 3 / Phase 5 |
| Dependabot ecosystem entries in `.github/dependabot.yml` (policy settled in D-032; `docker-compose` and `github-actions` are live; `npm` and `pip` come with each service in Phase 1, `terraform` with the first `.tf` file) | Phase 1 to Phase 5 |
| Re-verify tool status (supply-chain incidents, maintenance state) before Phase 3 | Phase 3 |

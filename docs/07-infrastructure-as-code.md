# 07: Infrastructure as Code (Terraform)

> **Status:** Approved with updates · **Last updated:** 2026-10-10
> Infrastructure as Code is worth **2 of 20 marks**.

---

## 1. Three layers, three tools

| Layer | Tool | Responsible for |
|---|---|---|
| **Cloud layer** | **Terraform** | Network, firewall, static IP, VM, service account, budget alert (if permitted), and bootstrapping k3s on the VM through a startup script |
| **Cluster layer** | One-time bootstrap (Helm) | cert-manager, Sealed Secrets, Prometheus and Grafana, and the data stores |
| **App layer** | CI/CD (Helm) | The 8 application services, deployed on every release |

This split avoids the chicken-and-egg problem of Terraform needing a cluster that Terraform itself creates.

## 2. What Terraform provisions on GCP

- Required API enablement (Compute and the others needed).
- A **VPC and subnet** and **firewall rules**: ports 80 and 443 open to the world; SSH only from Google's IAP range.
- A **reserved static external IP**, so DNS never changes on restart (a small hourly charge, paid from credits).
- A **dedicated service account** with minimal permissions, not the default one.
- **One VM:** about 2 vCPU and 8 GB RAM, Ubuntu LTS, a modest balanced disk, with a **startup script** that installs k3s and applies the initial settings.
- A **budget alert**, if billing permissions on the account allow it. Otherwise set it manually in the console.

## 3. Code layout and provider portability

Terraform cannot truly hide differences between clouds, so the design is a **consistent interface**: each cloud gets its own module with the same input variables and outputs, and the environment selects one.

```
/infra/terraform/
  modules/
    gcp-vm/          network + firewall + IP + VM
    aws-vm/          same inputs/outputs; built ONLY if GCP fails
    k3s-bootstrap/   startup script / cloud-init, shared by both
  envs/prod/         main.tf selecting a module, variables
```

- Shared outputs: `public_ip`, `ssh_user`, `instance_id`, so everything downstream stays cloud-agnostic.
- **Only the GCP module is written now.** The structure is ready for AWS.
- Other variables: `vm_enabled` (stop the VM when not needed to save credits) and machine size.

## 4. State (local state, approved)

**Local Terraform state is used** because the infrastructure is tiny and apply is manual. Conditions:

- **One designated person** (the sole developer) runs `terraform apply` from their own machine. No concurrent runs.
- **The state file is never committed.** The repo is public and state can contain sensitive values. `*.tfstate*` and any `*.tfvars` with real values are in `.gitignore` from day one.
- **State is backed up privately** (a copy on a second machine or private storage), never in the repo.
- **CI cannot run `terraform plan`** (runners do not have the state). CI runs only `fmt`, `validate`, `tflint` and the IaC security scan. The plan is run locally before applying.
- **If the state is lost**, the few resources can be deleted or re-imported by hand in the console. The risk is low.
- **Fallback:** a remote Cloud Storage bucket for state, if more than one person ever applies. Switching means adding a backend block and migrating state.

Secrets stay out of Terraform wherever possible so they never reach state. Application secrets use Sealed Secrets. Sensitive values arrive as environment variables.

## 5. Access

- **No public SSH.** Admin access goes through Google's **IAP tunnel** (free; removes a major attack surface). The AWS equivalent would be SSM Session Manager.
- **GitHub Actions authenticates to GCP through OIDC (Workload Identity Federation).** No long-lived cloud keys stored in GitHub.
- How the pipeline reaches the cluster to deploy is described in `08`.

## 6. Pipeline for infrastructure changes

- **On pushes that touch `/infra`:** `terraform fmt -check`, `validate`, **tflint**, and **Checkov** (see `09`). No plan in CI.
- **Apply is manual and approval-gated:** the operator reviews the local plan, then applies. Infrastructure changes are rare, and an automatic apply against a credit-funded account is an unnecessary risk.
- **Teardown:** `terraform destroy` after the live month ends, so nothing keeps consuming credits.

## 7. Terraform or OpenTofu

The assessment names **Terraform**, and its command-line tool is free for this use, so Terraform is the choice. OpenTofu, its open-source fork, can run the same code if ever needed.

## 8. What assessors will see

The repo holds the Terraform code, a README explaining the layers, and the plan and apply output, showing the environment is reproducible from code.

---

## Deferred decisions

| Decision | Settle in |
|---|---|
| Exact machine type, disk size and region | Settled as defaults: e2-standard-2, 40 GB balanced, asia-south1 (D-056); pricing re-checked at sign-up |
| Terraform provider and CLI versions to pin | Settled: `.terraform.lock.hcl` and `.github/tools.lock` (D-056) |
| Startup script contents | Settled: `startup.sh.tftpl` (D-056) |
| How the cluster-layer bootstrap is run | Settled: `deploy/bootstrap/bootstrap.sh` and `seal-secrets.sh` on the VM (D-056) |
| Whether the budget alert can be created by Terraform | Settled: optional resource, `create_budget` (D-056) |
| DNS provider and update mechanism | Settled: DuckDNS, A record set once to the static IP (D-056) |
| IAP firewall rule details and deploy-user setup | Settled: D-056 |

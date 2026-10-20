# Civic Issue Tracker: Infrastructure as Code (Terraform)

This directory contains the Terraform configuration for provisioning the single-node production infrastructure for Civic Issue Tracker on Google Cloud Platform (GCP), adhering to [docs/07-infrastructure-as-code.md](file:///d:/Semester_7/CNA/project/civic-issue-tracker/docs/07-infrastructure-as-code.md) and [docs/12-decision-log.md](file:///d:/Semester_7/CNA/project/civic-issue-tracker/docs/12-decision-log.md) (D-056).

## Three Architectural Layers

The infrastructure architecture is divided into three distinct layers to avoid circular dependencies:

1. **Cloud Layer (Terraform)**:
   - Provisions GCP network, custom VPC, firewall rules, static external IP, dedicated VM service account, Compute Engine VM with shielded VM settings, Workload Identity Federation (WIF) pool and deploy service account, and optional budget alert.
   - Bootstraps k3s on the VM via an automated, checksum-verified startup script.
2. **Cluster Layer (Bootstrap Scripts)**:
   - Run once on the VM by the operator as root (`deploy/bootstrap/bootstrap.sh` and `deploy/bootstrap/seal-secrets.sh`).
   - Installs cert-manager, Sealed Secrets controller, cluster issuers, namespaces, network policies, data stores, and runs database migrations.
3. **Application Layer (Helm CI/CD)**:
   - Deploys the 8 application microservices to the `civic-app` namespace on every release via GitHub Actions.

## Directory Layout

```
infra/terraform/
  modules/
    gcp-vm/          # Core GCP resources (VPC, firewall, static IP, VM, IAM, WIF)
    k3s-bootstrap/   # Rendered startup script for k3s, helm, and kubeseal
  envs/
    prod/            # Production environment root module
      main.tf
      variables.tf
      outputs.tf
      versions.tf
      terraform.tfvars.example
      .terraform.lock.hcl
```

## Variables (`envs/prod`)

| Variable | Type | Default | Description |
|---|---|---|---|
| `project_id` | string | *required* | GCP project ID where resources are deployed |
| `region` | string | `asia-south1` | GCP region (Mumbai) |
| `zone` | string | `asia-south1-a` | GCP compute zone |
| `machine_type` | string | `e2-standard-2` | Machine type (2 vCPU, 8 GB RAM) |
| `disk_size_gb` | number | `40` | Balanced persistent boot disk size in GB |
| `vm_enabled` | bool | `true` | Controls VM status (`RUNNING` or `TERMINATED`) to preserve disk/IP when paused |
| `github_repository` | string | `Gautam-Shah306/civic-issue-tracker` | GitHub repo authorized for Workload Identity Federation |
| `github_repository_owner_id` | string | *required* | Numeric GitHub owner ID for immutable OIDC binding |
| `public_host` | string | `nagriksetu.duckdns.org` | Public domain hostname |
| `create_budget` | bool | `false` | Whether to create Cloud Billing budget alerts |
| `billing_account_id` | string | `null` | Billing account ID (required if `create_budget` is true) |
| `budget_amount_usd` | number | `50` | Maximum monthly budget threshold in USD |

## Security & State Management Rules

> [!IMPORTANT]
> **State and Secrets Rules:**
> 1. **Local state only:** Terraform state (`*.tfstate`, `*.tfstate.*`) and plans (`*.tfplan`) are never committed to version control. They are strictly excluded in `.gitignore`.
> 2. **No committed credentials:** `terraform.tfvars` containing actual project or billing IDs is git-ignored. Only `terraform.tfvars.example` is tracked.
> 3. **No stored cloud keys:** Deployments use GitHub OIDC and Google Workload Identity Federation. No long-lived service account keys (`google_service_account_key`) are ever created.
> 4. **Firewall restrictions:** Only ports 80 and 443 are open to `0.0.0.0/0`. SSH (port 22) is open exclusively to Google Cloud IAP IP range `35.235.240.0/20`.

## Manual Apply Steps

Apply is manual and approval-gated. CI/CD never runs `terraform plan` or `terraform apply`.

### 1. Initialize Working Directory

```bash
cd infra/terraform/envs/prod
terraform init -backend=false
```

### 2. Configure Variables

Create `terraform.tfvars` from the example template:

```bash
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars` and set your real GCP `project_id` and `github_repository_owner_id`.
To look up your numeric GitHub repository owner ID, query the public GitHub API endpoint:

```bash
curl -s https://api.github.com/users/<owner> | jq .id
```

This numeric ID goes only into `terraform.tfvars` (never committed to git).

### 3. Generate and Review Plan

```bash
terraform plan -out=prod.tfplan
```

Review every proposed resource creation to verify that names, tags, and networks align with project policies.

### 4. Apply Changes

```bash
terraform apply prod.tfplan
```

### 5. GitHub Actions Deploy Variables & TLS Issuer Switch

The automated CD deploy job (`.github/workflows/images.yml`) requires the following repository variables configured in GitHub repository settings:
- **Repository Variables (names only):**
  - `DEPLOY_ENABLED`
  - `GCP_PROJECT_ID`
  - `GCP_PROJECT_NUMBER`
  - `GCP_WIF_PROVIDER`
  - `GCP_DEPLOY_SA`
  - `GCP_ZONE`
  - `GCP_INSTANCE`
  - `PUBLIC_HOST`
  - `CERT_ISSUER`

> [!IMPORTANT]
> `DEPLOY_ENABLED` must stay unset (or empty) until the VM exists, k3s is running, and cluster bootstrap scripts have completed.

To switch from the initial Let's Encrypt staging issuer to production:
1. Edit the `cert-manager.io/cluster-issuer` annotation in `deploy/k8s/30-ingress.yaml` to specify `letsencrypt-prod`.
2. Set the repository variable `CERT_ISSUER` to `letsencrypt-prod`.

### 6. Teardown / Destroy

When the live assessment month ends or during decommission, destroy all resources to prevent unnecessary credit consumption:

```bash
terraform destroy
```

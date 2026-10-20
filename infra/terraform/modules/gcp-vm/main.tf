locals {
  base_services = [
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
    "iap.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "serviceusage.googleapis.com",
    "oslogin.googleapis.com",
  ]
  services = var.create_budget ? concat(local.base_services, ["billingbudgets.googleapis.com"]) : local.base_services
}

# Required API enablement
resource "google_project_service" "enabled_apis" {
  for_each                   = toset(local.services)
  project                    = var.project_id
  service                    = each.key
  disable_on_destroy         = false
  disable_dependent_services = false
}

# Custom-mode VPC network
resource "google_compute_network" "vpc" {
  name                    = "civic-vpc"
  project                 = var.project_id
  auto_create_subnetworks = false

  depends_on = [google_project_service.enabled_apis]
}

# Subnet for the single-node cluster VM
resource "google_compute_subnetwork" "subnet" {
  #checkov:skip=CKV_GCP_26:Single VM pilot deployment; VPC flow logs incur unnecessary logging ingestion costs on 50 USD budget
  #checkov:skip=CKV_GCP_74:Single VM has static external IP; private Google access is redundant
  name          = "civic-subnet"
  project       = var.project_id
  region        = var.region
  network       = google_compute_network.vpc.id
  ip_cidr_range = "10.0.1.0/24"
}

# Ingress firewall: HTTP (80) and HTTPS (443) open to the world
resource "google_compute_firewall" "allow_http_https" {
  #checkov:skip=CKV_GCP_106:Port 80 ingress from 0.0.0.0/0 required for Let's Encrypt ACME HTTP-01 and Traefik redirect
  name        = "civic-allow-http-https"
  project     = var.project_id
  network     = google_compute_network.vpc.name
  description = "Allow inbound HTTP and HTTPS traffic from any source"

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["civic-vm"]
}

# Ingress firewall: SSH (22) exclusively from Google Cloud IAP IP block
resource "google_compute_firewall" "allow_iap_ssh" {
  name        = "civic-allow-iap-ssh"
  project     = var.project_id
  network     = google_compute_network.vpc.name
  description = "Allow inbound SSH traffic exclusively from Google Cloud IAP IP range"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["civic-vm"]
}

# Reserved regional static external IP
resource "google_compute_address" "static_ip" {
  name         = "civic-static-ip"
  project      = var.project_id
  region       = var.region
  address_type = "EXTERNAL"
  description  = "Reserved regional static external IP for the civic cluster VM"

  depends_on = [google_project_service.enabled_apis]
}

# Dedicated VM service account with no project roles by default
resource "google_service_account" "vm_sa" {
  account_id   = "civic-vm-sa"
  display_name = "Civic VM Service Account"
  project      = var.project_id
  description  = "Dedicated service account for the single-node VM with no project roles by default"

  depends_on = [google_project_service.enabled_apis]
}

# Ubuntu 24.04 LTS official image data source
data "google_compute_image" "ubuntu" {
  family  = "ubuntu-2404-lts-amd64"
  project = "ubuntu-os-cloud"
}

# Single-node cluster VM
resource "google_compute_instance" "vm" {
  #checkov:skip=CKV_GCP_38:Google default encryption (GMEK) used; CSEK/CMEK adds operational complexity and KMS costs
  #checkov:skip=CKV_GCP_40:Single VM terminates public traffic on static IP; Cloud Load Balancer avoided for cost
  name                      = "civic-vm"
  project                   = var.project_id
  zone                      = var.zone
  machine_type              = var.machine_type
  desired_status            = var.vm_enabled ? "RUNNING" : "TERMINATED"
  allow_stopping_for_update = true
  can_ip_forward            = false
  tags                      = ["civic-vm"]

  boot_disk {
    initialize_params {
      image = data.google_compute_image.ubuntu.self_link
      size  = var.disk_size_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.subnet.self_link
    access_config {
      nat_ip = google_compute_address.static_ip.address
    }
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  service_account {
    email  = google_service_account.vm_sa.email
    scopes = ["cloud-platform"]
  }

  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    startup-script         = var.startup_script
  }
}

# Deploy identity: Workload Identity Pool
resource "google_iam_workload_identity_pool" "github_pool" {
  project                   = var.project_id
  workload_identity_pool_id = "github-actions-pool"
  display_name              = "GitHub Actions Pool"
  description               = "Workload Identity Pool for GitHub Actions deployments"

  depends_on = [google_project_service.enabled_apis]
}

# Deploy identity: Workload Identity Pool Provider with GitHub OIDC
resource "google_iam_workload_identity_pool_provider" "github_provider" {
  #checkov:skip=CKV_GCP_125:attribute_condition validates repository, repository_owner_id, and ref; Checkov static AST requires assertion.sub
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github_pool.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-provider"
  display_name                       = "GitHub Actions OIDC Provider"
  description                        = "OIDC identity provider for GitHub Actions"

  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository"          = "assertion.repository"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.ref"                 = "assertion.ref"
  }

  attribute_condition = "assertion.repository == '${var.github_repository}' && assertion.repository_owner_id == '${var.github_repository_owner_id}' && assertion.ref == 'refs/heads/main'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Deploy service account for CI/CD
resource "google_service_account" "deploy_sa" {
  account_id   = "civic-deploy"
  display_name = "Civic Deploy Service Account"
  project      = var.project_id
  description  = "Deploy service account used by GitHub Actions CI/CD via Workload Identity Federation"

  depends_on = [google_project_service.enabled_apis]
}

# Workload Identity User binding restricted to the repository attribute
resource "google_service_account_iam_member" "deploy_sa_wif" {
  service_account_id = google_service_account.deploy_sa.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github_pool.name}/attribute.repository/${var.github_repository}"
}

# Instance-level OS Admin Login:
# osAdminLogin is accepted on this single VM instance because Helm and cluster scripts require access
# to root-readable kubeconfig (/etc/rancher/k3s/k3s.yaml) during deployments, and the civic-deploy
# account is already trusted to roll out application code (D-056).
resource "google_compute_instance_iam_member" "deploy_sa_os_admin" {
  project       = var.project_id
  zone          = var.zone
  instance_name = google_compute_instance.vm.name
  role          = "roles/compute.osAdminLogin"
  member        = "serviceAccount:${google_service_account.deploy_sa.email}"
}

# Instance-level IAP tunnel access for secure administrative access through Google Cloud IAP
resource "google_iap_tunnel_instance_iam_member" "deploy_sa_iap" {
  project  = var.project_id
  zone     = var.zone
  instance = google_compute_instance.vm.name
  role     = "roles/iap.tunnelResourceAccessor"
  member   = "serviceAccount:${google_service_account.deploy_sa.email}"
}

# Project-level Compute Viewer role so gcloud compute can inspect VM metadata and state
resource "google_project_iam_member" "deploy_sa_compute_viewer" {
  project = var.project_id
  role    = "roles/compute.viewer"
  member  = "serviceAccount:${google_service_account.deploy_sa.email}"
}

# Service Account User role on the VM service account
resource "google_service_account_iam_member" "deploy_sa_actas_vm" {
  service_account_id = google_service_account.vm_sa.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deploy_sa.email}"
}

# Optional budget alert created only when create_budget is true and billing_account_id is provided
resource "google_billing_budget" "budget" {
  count           = var.create_budget && var.billing_account_id != null ? 1 : 0
  billing_account = var.billing_account_id
  display_name    = "Civic Issue Tracker Budget Alert"

  budget_filter {
    projects = ["projects/${var.project_id}"]
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_amount_usd)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }

  depends_on = [google_project_service.enabled_apis]
}

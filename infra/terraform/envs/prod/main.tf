provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

module "k3s_bootstrap" {
  source = "../../modules/k3s-bootstrap"

  public_host = var.public_host
}

module "gcp_vm" {
  source = "../../modules/gcp-vm"

  project_id                 = var.project_id
  region                     = var.region
  zone                       = var.zone
  machine_type               = var.machine_type
  disk_size_gb               = var.disk_size_gb
  vm_enabled                 = var.vm_enabled
  github_repository          = var.github_repository
  github_repository_owner_id = var.github_repository_owner_id
  public_host                = var.public_host
  create_budget              = var.create_budget
  billing_account_id         = var.billing_account_id
  budget_amount_usd          = var.budget_amount_usd
  startup_script             = module.k3s_bootstrap.startup_script
}

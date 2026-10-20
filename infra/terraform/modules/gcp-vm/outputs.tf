output "public_ip" {
  description = "Reserved regional static external IP address of the VM"
  value       = google_compute_address.static_ip.address
}

output "ssh_user" {
  description = "OS Login SSH username note: format is sa_<numeric_unique_id> for service accounts or user_domain_com for human users"
  value       = "sa_${google_service_account.deploy_sa.unique_id}"
}

output "instance_id" {
  description = "Unique numeric instance ID of the Compute Engine VM"
  value       = google_compute_instance.vm.instance_id
}

output "instance_name" {
  description = "Name of the Compute Engine VM instance"
  value       = google_compute_instance.vm.name
}

output "zone" {
  description = "GCP zone in which the instance is running"
  value       = var.zone
}

output "deploy_service_account_email" {
  description = "Email of the deploy service account used by CI/CD"
  value       = google_service_account.deploy_sa.email
}

output "workload_identity_provider" {
  description = "Full resource name of the Workload Identity Pool Provider for GitHub Actions"
  value       = google_iam_workload_identity_pool_provider.github_provider.name
}

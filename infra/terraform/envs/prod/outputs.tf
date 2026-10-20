output "public_ip" {
  description = "Reserved regional static external IP address of the VM"
  value       = module.gcp_vm.public_ip
}

output "ssh_user" {
  description = "OS Login SSH username note: format is sa_<numeric_unique_id> for service accounts or user_domain_com for human users"
  value       = module.gcp_vm.ssh_user
}

output "instance_id" {
  description = "Unique numeric instance ID of the Compute Engine VM"
  value       = module.gcp_vm.instance_id
}

output "instance_name" {
  description = "Name of the Compute Engine VM instance"
  value       = module.gcp_vm.instance_name
}

output "zone" {
  description = "GCP zone in which the instance is running"
  value       = module.gcp_vm.zone
}

output "deploy_service_account_email" {
  description = "Email of the deploy service account used by CI/CD"
  value       = module.gcp_vm.deploy_service_account_email
}

output "workload_identity_provider" {
  description = "Full resource name of the Workload Identity Pool Provider for GitHub Actions"
  value       = module.gcp_vm.workload_identity_provider
}

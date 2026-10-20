variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type        = string
  description = "GCP region"
  default     = "asia-south1"
}

variable "zone" {
  type        = string
  description = "GCP zone"
  default     = "asia-south1-a"
}

variable "machine_type" {
  type        = string
  description = "Compute Engine machine type"
  default     = "e2-standard-2"
}

variable "disk_size_gb" {
  type        = number
  description = "Boot disk size in GB"
  default     = 40
}

variable "vm_enabled" {
  type        = bool
  description = "Control VM desired_status: true for RUNNING, false for TERMINATED"
  default     = true
}

variable "github_repository" {
  type        = string
  description = "GitHub repository for Workload Identity Federation (format: Owner/Repo)"
  default     = "Gautam-Shah306/civic-issue-tracker"
}

variable "github_repository_owner_id" {
  type        = string
  description = "Immutable numeric GitHub repository owner ID"
  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_owner_id))
    error_message = "github_repository_owner_id must be a numeric string."
  }
}

variable "public_host" {
  type        = string
  description = "Public domain hostname"
  default     = "nagriksetu.duckdns.org"
}

variable "create_budget" {
  type        = bool
  description = "Whether to create Cloud Billing budget alert"
  default     = false
}

variable "billing_account_id" {
  type        = string
  description = "GCP billing account ID (required if create_budget is true)"
  default     = null
}

variable "budget_amount_usd" {
  type        = number
  description = "Budget alert limit in USD"
  default     = 50
}

variable "startup_script" {
  type        = string
  description = "Rendered startup script for VM bootstrapping"
}

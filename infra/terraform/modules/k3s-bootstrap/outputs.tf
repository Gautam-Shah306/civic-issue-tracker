output "startup_script" {
  description = "Rendered startup script for Compute Engine VM bootstrapping"
  value       = local.startup_script
}

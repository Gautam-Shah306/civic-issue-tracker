locals {
  startup_script = templatefile("${path.module}/startup.sh.tftpl", {
    k3s_version           = var.k3s_version
    k3s_sha256            = var.k3s_sha256
    k3s_install_sh_sha256 = var.k3s_install_sh_sha256
    helm_version          = var.helm_version
    helm_sha256           = var.helm_sha256
    kubeseal_version      = var.kubeseal_version
    kubeseal_sha256       = var.kubeseal_sha256
    public_host           = var.public_host
    traefik_config        = file("${path.module}/../../../../deploy/bootstrap/traefik-config.yaml")
  })
}

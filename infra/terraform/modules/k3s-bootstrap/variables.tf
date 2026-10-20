variable "k3s_version" {
  type        = string
  description = "Pinned version of k3s binary and installer"
  default     = "v1.35.9+k3s1"
  # Source URL: https://github.com/k3s-io/k3s/releases/tag/v1.35.9+k3s1
}

variable "k3s_sha256" {
  type        = string
  description = "SHA-256 checksum of the linux-amd64 k3s binary"
  default     = "897acb21cca57d477a211102251a6591450ce767344a9faaa121a1007ca9fa9a"
  # Source URL: https://github.com/k3s-io/k3s/releases/download/v1.35.9%2Bk3s1/sha256sum-amd64.txt
}

variable "k3s_install_sh_sha256" {
  type        = string
  description = "SHA-256 checksum of the k3s install.sh script from the release tag"
  default     = "8598e002e61d658fed7b7542fc6d2c66d8da6eae69e088830105d2ee1ffb6d91"
  # Source URL: https://raw.githubusercontent.com/k3s-io/k3s/v1.35.9%2Bk3s1/install.sh
}

variable "helm_version" {
  type        = string
  description = "Pinned version of the Helm binary"
  default     = "v4.3.0"
  # Source URL: https://get.helm.sh/helm-v4.3.0-linux-amd64.tar.gz
}

variable "helm_sha256" {
  type        = string
  description = "SHA-256 checksum of the linux-amd64 Helm archive"
  default     = "86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb"
  # Source URL: https://get.helm.sh/helm-v4.3.0-linux-amd64.tar.gz.sha256sum
}

variable "kubeseal_version" {
  type        = string
  description = "Pinned version of the kubeseal CLI"
  default     = "0.40.0"
  # Source URL: https://github.com/bitnami-labs/sealed-secrets/releases/tag/v0.40.0
}

variable "kubeseal_sha256" {
  type        = string
  description = "SHA-256 checksum of the linux-amd64 kubeseal archive"
  default     = "9314c35916646e9d59c8f06b1314574b4e79c4d76f079433607ed7b697bb5eb7"
  # Source URL: https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.40.0/sealed-secrets_0.40.0_checksums.txt
}

variable "public_host" {
  type        = string
  description = "Public domain hostname for the TLS SAN certificate"
  default     = "nagriksetu.duckdns.org"
}

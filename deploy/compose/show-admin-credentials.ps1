# WARNING: Never paste, share, or log the output of this script.
# It prints the bootstrap administrator credentials for this deployment to the local terminal on explicit invocation.

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$envPath = Join-Path $scriptDir ".env"

if (-not (Test-Path $envPath)) {
    Write-Error "Deployment environment file (.env) not found in $scriptDir. Run init-env.ps1 first."
    exit 1
}

$email = $null
$password = $null

$lines = Get-Content $envPath
foreach ($line in $lines) {
    $trimmed = $line.Trim()
    if ($trimmed -match '^BOOTSTRAP_ADMIN_EMAIL\s*=\s*(.*)$') {
        $email = $Matches[1].Trim()
    } elseif ($trimmed -match '^BOOTSTRAP_ADMIN_PASSWORD\s*=\s*(.*)$') {
        $password = $Matches[1].Trim()
    }
}

if (-not $email -or -not $password) {
    Write-Error "BOOTSTRAP_ADMIN_EMAIL or BOOTSTRAP_ADMIN_PASSWORD not set in $envPath."
    exit 1
}

Write-Host "Bootstrap Admin Email:    $email"
Write-Host "Bootstrap Admin Password: $password"

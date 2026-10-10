$ErrorActionPreference = 'Stop'

$GITLEAKS_VERSION = "v8.30.1"
$EXPECTED_SHA256 = "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e"
$ZIP_NAME = "gitleaks_8.30.1_windows_x64.zip"
$DOWNLOAD_URL = "https://github.com/gitleaks/gitleaks/releases/download/$GITLEAKS_VERSION/$ZIP_NAME"

$REPO_ROOT = (git rev-parse --show-toplevel).Trim()
$TMP_DIR = Join-Path $REPO_ROOT ".local\tmp"
$EXTRACT_DIR = Join-Path $TMP_DIR "extract"
$BIN_DIR = Join-Path $REPO_ROOT ".local\bin"
$ZIP_PATH = Join-Path $TMP_DIR $ZIP_NAME

Write-Host "Creating directories..."
if (-not (Test-Path $TMP_DIR)) { New-Item -ItemType Directory -Force $TMP_DIR | Out-Null }
if (-not (Test-Path $BIN_DIR)) { New-Item -ItemType Directory -Force $BIN_DIR | Out-Null }
if (Test-Path $EXTRACT_DIR) { Remove-Item -Recurse -Force $EXTRACT_DIR | Out-Null }
New-Item -ItemType Directory -Force $EXTRACT_DIR | Out-Null

Write-Host "Downloading Gitleaks $GITLEAKS_VERSION..."
Invoke-WebRequest -Uri $DOWNLOAD_URL -OutFile $ZIP_PATH

Write-Host "Verifying checksum..."
$hash = (Get-FileHash -Path $ZIP_PATH -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $EXPECTED_SHA256.ToLower()) {
    Write-Error "Checksum mismatch! Expected: $EXPECTED_SHA256, Got: $hash. Aborting installation."
    exit 1
}

Write-Host "Checksum verified. Extracting..."
Expand-Archive -Path $ZIP_PATH -DestinationPath $EXTRACT_DIR -Force

Write-Host "Copying gitleaks.exe..."
$extractedExe = Join-Path $EXTRACT_DIR "gitleaks.exe"
$gitleaksPath = Join-Path $BIN_DIR "gitleaks.exe"
Copy-Item -Path $extractedExe -Destination $gitleaksPath -Force

Write-Host "Verifying Gitleaks version..."
$versionOutput = (& $gitleaksPath version).Trim()
$expectedVersionStr = $GITLEAKS_VERSION.TrimStart('v')
if ($versionOutput -ne $expectedVersionStr) {
    Write-Host "Version mismatch! Expected: $expectedVersionStr, Got: $versionOutput."
    Write-Host "Deleting installed binary and aborting."
    Remove-Item -Path $gitleaksPath -Force
    exit 1
}

Write-Host "Configuring git hooks path..."
git config core.hooksPath .githooks

Write-Host "Setup complete!"

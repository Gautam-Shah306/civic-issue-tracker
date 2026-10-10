$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$envPath = Join-Path $scriptDir ".env"
$envExamplePath = Join-Path $scriptDir ".env.example"

if (Test-Path $envPath) {
    Write-Host "File .env already exists. Skipping creation to avoid overwriting."
    exit 0
}

if (-not (Test-Path $envExamplePath)) {
    Write-Error "File .env.example not found."
    exit 1
}

function Get-RandomString {
    $length = 32
    $bytes = New-Object Byte[] $length
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return [Convert]::ToBase64String($bytes) -replace "[^a-zA-Z0-9]", ""
}

$lines = Get-Content $envExamplePath
$newLines = @()
foreach ($line in $lines) {
    if ($line -match "CHANGE_ME") {
        $randomStr = Get-RandomString
        $newLines += $line -replace "CHANGE_ME", $randomStr
    } else {
        $newLines += $line
    }
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($envPath, ($newLines -join "`n") + "`n", $utf8NoBom)
Write-Host "Created .env with random secure credentials."

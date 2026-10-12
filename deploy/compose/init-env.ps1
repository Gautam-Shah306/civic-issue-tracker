$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$envPath = Join-Path $scriptDir ".env"
$envExamplePath = Join-Path $scriptDir ".env.example"

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

$utf8NoBom = New-Object System.Text.UTF8Encoding $false

if (-not (Test-Path $envPath)) {
    $exampleLines = Get-Content $envExamplePath
    $newLines = @()
    foreach ($line in $exampleLines) {
        if ($line -match "CHANGE_ME") {
            $randomStr = Get-RandomString
            $newLines += $line -replace "CHANGE_ME", $randomStr
        } else {
            $newLines += $line
        }
    }
    [System.IO.File]::WriteAllText($envPath, ($newLines -join "`n") + "`n", $utf8NoBom)
    Write-Host "Created .env with random secure credentials."
    exit 0
}

# If .env already exists, append missing keys from .env.example without modifying or printing existing values
$existingText = [System.IO.File]::ReadAllText($envPath)
$existingLines = $existingText -split "`r?`n"
$existingKeys = @{}

foreach ($line in $existingLines) {
    $trimmed = $line.Trim()
    if ($trimmed -and -not $trimmed.StartsWith("#") -and ($trimmed -match '^([A-Za-z_][A-Za-z0-9_]*)\s*=')) {
        $existingKeys[$Matches[1]] = $true
    }
}

$exampleLines = Get-Content $envExamplePath
$appendedLines = @()

foreach ($line in $exampleLines) {
    $trimmed = $line.Trim()
    if ($trimmed -and -not $trimmed.StartsWith("#") -and ($trimmed -match '^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$')) {
        $key = $Matches[1]
        $valTemplate = $Matches[2]
        if (-not $existingKeys.ContainsKey($key)) {
            if ($valTemplate -match "CHANGE_ME") {
                $val = $valTemplate -replace "CHANGE_ME", (Get-RandomString)
            } else {
                $val = $valTemplate
            }
            $appendedLines += "$key=$val"
        }
    }
}

if ($appendedLines.Count -gt 0) {
    $suffix = ($appendedLines -join "`n") + "`n"
    if ($existingText.Length -gt 0 -and -not $existingText.EndsWith("`n")) {
        $suffix = "`n" + $suffix
    }
    [System.IO.File]::AppendAllText($envPath, $suffix, $utf8NoBom)
    Write-Host "Appended $($appendedLines.Count) missing variable(s) to .env."
} else {
    Write-Host ".env already contains all variables from .env.example."
}

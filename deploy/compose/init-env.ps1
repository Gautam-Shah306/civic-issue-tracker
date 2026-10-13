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

function Get-Ed25519KeyPair {
    $script = "const crypto=require('crypto');const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');const priv=Buffer.from(privateKey.export({type:'pkcs8',format:'pem'})).toString('base64');const pub=Buffer.from(publicKey.export({type:'spki',format:'pem'})).toString('base64');console.log(JSON.stringify({priv,pub}));"
    $image = "node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20"
    $json = docker run --rm $image node -e $script
    return ($json | ConvertFrom-Json)
}

$utf8NoBom = New-Object System.Text.UTF8Encoding $false
$generatedKeyPair = $null

if (-not (Test-Path $envPath)) {
    $exampleLines = Get-Content $envExamplePath
    $newLines = @()
    foreach ($line in $exampleLines) {
        if ($line -match '^JWT_PRIVATE_KEY_B64=CHANGE_ME') {
            if ($null -eq $generatedKeyPair) {
                $generatedKeyPair = Get-Ed25519KeyPair
            }
            $newLines += "JWT_PRIVATE_KEY_B64=$($generatedKeyPair.priv)"
        } elseif ($line -match '^JWT_PUBLIC_KEY_B64=CHANGE_ME') {
            if ($null -eq $generatedKeyPair) {
                $generatedKeyPair = Get-Ed25519KeyPair
            }
            $newLines += "JWT_PUBLIC_KEY_B64=$($generatedKeyPair.pub)"
        } elseif ($line -match "CHANGE_ME") {
            $randomStr = Get-RandomString
            $newLines += $line -replace "CHANGE_ME", $randomStr
        } else {
            $newLines += $line
        }
    }
    [System.IO.File]::WriteAllText($envPath, ($newLines -join "`n") + "`n", $utf8NoBom)
    Write-Host "Created .env with random secure credentials and Ed25519 key pair."
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
            if ($key -eq "JWT_PRIVATE_KEY_B64") {
                if ($null -eq $generatedKeyPair) {
                    $generatedKeyPair = Get-Ed25519KeyPair
                }
                $val = $generatedKeyPair.priv
            } elseif ($key -eq "JWT_PUBLIC_KEY_B64") {
                if ($null -eq $generatedKeyPair) {
                    $generatedKeyPair = Get-Ed25519KeyPair
                }
                $val = $generatedKeyPair.pub
            } elseif ($valTemplate -match "CHANGE_ME") {
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

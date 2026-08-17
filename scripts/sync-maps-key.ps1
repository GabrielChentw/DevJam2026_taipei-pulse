# Compare the API key in web/.env.local against the keys that actually exist in the
# GCP project, and fix .env.local if they differ.
#
# This is the decisive check. `gcloud services api-keys list` shows key resource names
# and restrictions but NOT the key string, so a project can look perfectly configured
# while the app is using a key from an entirely different project. That mismatch produces
# the "for development purposes only" watermark with no other symptom.
#
# Requires: gcloud installed, `gcloud auth login` completed.
#
# NOTE: ASCII only. Windows PowerShell 5.1 reads .ps1 as ANSI, so non-ASCII comments
# corrupt the parser.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\sync-maps-key.ps1

$gcloud  = Join-Path $env:LOCALAPPDATA 'Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'
$envPath = Join-Path $PSScriptRoot '..\web\.env.local'

if (-not (Test-Path $gcloud))  { Write-Output "gcloud not found at $gcloud"; exit 1 }
if (-not (Test-Path $envPath)) { Write-Output "not found: $envPath"; exit 1 }

function Mask {
    param([string]$Value)
    if ([string]::IsNullOrEmpty($Value)) { return '<empty>' }
    if ($Value.Length -le 14) { return $Value.Substring(0, 4) + '...' }
    return $Value.Substring(0, 10) + '...' + $Value.Substring($Value.Length - 4)
}

# --- current value in .env.local ---
$lines   = [System.IO.File]::ReadAllLines($envPath, [System.Text.Encoding]::UTF8)
$keyLine = $lines | Where-Object { $_ -like '*VITE_GOOGLE_MAPS_API_KEY*=*' } | Select-Object -First 1
$localKey = if ($keyLine) { ($keyLine -split '=', 2)[1].Trim().Trim('"').Trim("'") } else { '' }

Write-Output '===== KEY IN web/.env.local ====='
Write-Output "  $(Mask $localKey)   (length $($localKey.Length))"

# --- keys that actually exist in the project ---
$project = (& $gcloud config get-value project 2>$null | Select-Object -First 1)
if (-not $project -or $project -eq '(unset)') {
    $ids = @(& $gcloud projects list '--format=value(projectId)' 2>$null | Where-Object { $_ })
    if ($ids.Count -ne 1) { Write-Output "Cannot determine project ($($ids.Count) visible). Run: gcloud config set project ID"; exit 1 }
    $project = $ids[0]
}

Write-Output ''
Write-Output "===== KEYS IN PROJECT $project ====="

$names = @(& $gcloud services api-keys list "--project=$project" '--format=value(name)' 2>$null | Where-Object { $_ })

if ($names.Count -eq 0) { Write-Output '  none found'; exit 1 }

$match = $false
$firstKeyString = ''

foreach ($name in $names) {
    $keyString = (& $gcloud services api-keys get-key-string $name '--format=value(keyString)' 2>$null | Select-Object -First 1)
    if (-not $firstKeyString) { $firstKeyString = $keyString }

    $same = ($keyString -eq $localKey)
    if ($same) { $match = $true }

    $flag = if ($same) { 'MATCHES .env.local' } else { 'different' }
    Write-Output "  $(Mask $keyString)   $flag"
}

Write-Output ''
Write-Output '===== VERDICT ====='

if ($match) {
    Write-Output 'The key in .env.local DOES belong to this project.'
    Write-Output 'So the watermark is not caused by a wrong-project key. Look elsewhere.'
    exit 0
}

Write-Output 'MISMATCH: the key in .env.local does NOT exist in this project.'
Write-Output 'That is the cause of the watermark: the app was using a key from a different'
Write-Output 'project (most likely one created while signed in as a personal account).'
Write-Output ''
Write-Output 'Rewriting web/.env.local with the correct key from this project.'

$updated = $lines | ForEach-Object {
    if ($_ -like '*VITE_GOOGLE_MAPS_API_KEY*=*') { "VITE_GOOGLE_MAPS_API_KEY=$firstKeyString" } else { $_ }
}

# UTF8 without BOM, so Vite parses it cleanly.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($envPath, $updated, $utf8NoBom)

Write-Output "Done. New value: $(Mask $firstKeyString)"
Write-Output 'Restart the dev server, then hard-reload the browser with Ctrl+Shift+R.'

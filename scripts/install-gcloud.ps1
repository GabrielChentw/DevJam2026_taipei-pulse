# Install the Google Cloud SDK from the ZIP distribution.
#
# Why not winget: the Google.CloudSDK winget package runs GoogleCloudSDKInstaller.exe,
# which is an interactive GUI wizard. It cannot be driven from a script, and
# --disable-interactivity does not help because the interactivity is in the installer
# itself, not in winget.
#
# The ZIP distribution needs no installer, no admin rights, and is fully scriptable.
#
# NOTE: ASCII only. Windows PowerShell 5.1 reads .ps1 as ANSI, so non-ASCII comments
# corrupt the parser.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install-gcloud.ps1

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Write-Progress is very slow over a PTY

$installRoot = Join-Path $env:LOCALAPPDATA 'Google\Cloud SDK'
$sdkDir      = Join-Path $installRoot 'google-cloud-sdk'
$gcloudCmd   = Join-Path $sdkDir 'bin\gcloud.cmd'

if (Test-Path $gcloudCmd) {
    Write-Output "ALREADY INSTALLED: $gcloudCmd"
    exit 0
}

$zipUrl  = 'https://dl.google.com/dl/cloudsdk/channels/rapid/google-cloud-sdk.zip'
$zipPath = Join-Path $env:TEMP 'google-cloud-sdk.zip'

if (-not (Test-Path $zipPath)) {
    Write-Output "Downloading $zipUrl"
    Write-Output '(about 150 MB, this takes a few minutes)'
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
}

$sizeMb = [Math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Output "Downloaded: $zipPath  ($sizeMb MB)"

New-Item -ItemType Directory -Force -Path $installRoot | Out-Null

Write-Output "Extracting to $installRoot"
Expand-Archive -Path $zipPath -DestinationPath $installRoot -Force

if (-not (Test-Path $gcloudCmd)) {
    Write-Output "FAILED: expected $gcloudCmd after extraction"
    exit 1
}

Write-Output "INSTALLED: $gcloudCmd"
Write-Output ''
Write-Output 'Version:'
& $gcloudCmd --version

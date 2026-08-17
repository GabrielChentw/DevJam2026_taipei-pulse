# Authenticated audit of the GCP setup behind the Maps API key.
#
# This answers the questions the unauthenticated probes in check-maps-key.ps1 cannot:
#   - which projects this account can see
#   - which project the API key in web/.env.local actually belongs to
#   - whether Maps JavaScript API is enabled on it
#   - whether billing is linked
#   - what restrictions each key carries
#
# Requires: gcloud installed and `gcloud auth login` completed.
#
# NOTE: ASCII only. Windows PowerShell 5.1 reads .ps1 as ANSI, so non-ASCII comments
# corrupt the parser.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\gcp-audit.ps1

$gcloud = Join-Path $env:LOCALAPPDATA 'Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd'

if (-not (Test-Path $gcloud)) {
    Write-Output "gcloud not found at $gcloud"
    Write-Output 'Run scripts\install-gcloud.ps1 first.'
    exit 1
}

function Run {
    param([string]$Label, [string[]]$GcloudArgs)

    Write-Output ''
    Write-Output "===== $Label ====="
    Write-Output "> gcloud $($GcloudArgs -join ' ')"
    & $gcloud @GcloudArgs 2>&1 | ForEach-Object { Write-Output $_ }
}

Run 'ACTIVE ACCOUNT' @('auth', 'list', '--format=value(account,status)')
Run 'VISIBLE PROJECTS' @('projects', 'list', '--format=table(projectId,projectNumber,name,lifecycleState)')

# Determine the project to audit: explicit config, else the only project available.
$configured = (& $gcloud config get-value project 2>$null | Select-Object -First 1)
if ($configured -eq '(unset)') { $configured = '' }

$project = $configured
if (-not $project) {
    $ids = @(& $gcloud projects list '--format=value(projectId)' 2>$null | Where-Object { $_ })
    if ($ids.Count -eq 1) {
        $project = $ids[0]
        Write-Output ''
        Write-Output "Only one project visible, auditing it: $project"
    }
    else {
        Write-Output ''
        Write-Output "Found $($ids.Count) projects and none configured."
        Write-Output 'Set one with: gcloud config set project PROJECT_ID   then re-run.'
    }
}

if ($project) {
    Write-Output ''
    Write-Output "########## AUDITING PROJECT: $project ##########"

    Run 'ENABLED APIS (maps related)' @('services', 'list', '--enabled', "--project=$project", '--format=value(config.name,config.title)')

    Run 'BILLING LINK' @('billing', 'projects', 'describe', $project, '--format=yaml')

    # API keys live in the API Keys API. This prints restrictions, which is the one
    # thing the unauthenticated probes could never see.
    Run 'API KEYS AND RESTRICTIONS' @('services', 'api-keys', 'list', "--project=$project", '--format=yaml')
}

Write-Output ''
Write-Output '===== WHAT TO LOOK FOR ====='
Write-Output '1. ENABLED APIS must contain maps-backend.googleapis.com (that IS Maps JavaScript API).'
Write-Output '2. BILLING LINK must show billingEnabled: true.'
Write-Output '3. API KEYS: find the key matching web/.env.local. Check its restrictions block.'
Write-Output '   - browserKeyRestrictions present -> referer restricted, must include localhost:5173'
Write-Output '   - apiTargets present -> must include maps-backend.googleapis.com'
Write-Output '   - key absent from this list -> the key belongs to a DIFFERENT project'

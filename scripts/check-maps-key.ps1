# Diagnose the real state of the Google Maps API key.
#
# Why this exists: when Maps JavaScript API auth fails in the browser it only draws a
# vague "This page didn't load Google Maps correctly" box. The specific reason is in the
# console, and the 3D Maps failure path does not reliably go through the 2D
# gm_authFailure convention, so it cannot always be intercepted from the app.
#
# This script calls Google REST endpoints with your key. Google replies with an explicit
# JSON error that contains the project number and a direct link to what needs enabling.
#
# It also gives a clean bisection:
#   passes here, fails in browser -> HTTP referer restriction (curl sends no referer)
#   fails here                    -> billing or API-not-enabled, unrelated to referer
#
# NOTE: ASCII only. Windows PowerShell 5.1 reads .ps1 as ANSI, so non-ASCII comments
# corrupt the parser.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\check-maps-key.ps1

$envPath = Join-Path $PSScriptRoot '..\web\.env.local'

if (-not (Test-Path $envPath)) {
    Write-Output "NOT FOUND: $envPath"
    Write-Output "Run: Copy-Item web\.env.example web\.env.local  then fill in the key."
    exit 1
}

# Read as UTF-8 explicitly. Windows PowerShell 5.1 defaults to the ANSI code page,
# which mangles the non-ASCII comments in .env.local and can break line matching.
$lines = [System.IO.File]::ReadAllLines($envPath, [System.Text.Encoding]::UTF8)

$line = $lines | Where-Object { $_ -like '*VITE_GOOGLE_MAPS_API_KEY*=*' } | Select-Object -First 1

if (-not $line) {
    Write-Output 'NOT FOUND: VITE_GOOGLE_MAPS_API_KEY in .env.local'
    Write-Output "DEBUG: read $($lines.Count) lines from $envPath"
    Write-Output 'DEBUG: lines that are not comments or blank:'
    $lines | Where-Object { $_.Trim() -ne '' -and -not $_.Trim().StartsWith('#') } | ForEach-Object {
        $shown = $_
        if ($shown.Length -gt 34) { $shown = $shown.Substring(0, 34) + '...' }
        Write-Output "  [$shown]"
    }
    exit 1
}

$key = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")

Write-Output '===== KEY FORMAT ====='
Write-Output "length : $($key.Length)   (expected 39)"
Write-Output "prefix : $($key.Substring(0, [Math]::Min(6, $key.Length)))..."

if ($key.Length -ne 39) { Write-Output 'WARN: length is not 39, key may be truncated or padded' }
if ($key -notmatch '^AIza') { Write-Output 'WARN: does not start with AIza, wrong credential type?' }

function Probe {
    param([string]$Label, [string]$Uri)

    Write-Output ''
    Write-Output "===== $Label ====="

    try {
        $r = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 30
        Write-Output "HTTP $($r.StatusCode) OK"
        $body = $r.Content
        if ($body.Length -gt 500) { $body = $body.Substring(0, 500) + ' ...[truncated]' }
        Write-Output $body.Replace($key, '<REDACTED>')
    }
    catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) {
            Write-Output "CONNECTION FAILED: $($_.Exception.Message)"
            return
        }
        Write-Output "HTTP $([int]$resp.StatusCode)"
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $reader.ReadToEnd()
        $reader.Close()
        Write-Output $body.Replace($key, '<REDACTED>')
    }
}

# Map Tiles API returns structured JSON errors that include the project number.
# Our Map3DElement path does not need this API; it is used here purely as a probe
# to make Google tell us which project the key belongs to.
$tilesUri = 'https://tile.googleapis.com/v1/3dtiles/root.json?key=' + $key
Probe -Label 'PROBE 1: Map Tiles API (asks Google for the project number)' -Uri $tilesUri

# The actual Maps JavaScript API bootstrap the frontend loads.
$jsUri = 'https://maps.googleapis.com/maps/api/js?key=' + $key + '&v=alpha&libraries=maps3d'
Probe -Label 'PROBE 2: Maps JavaScript API bootstrap' -Uri $jsUri

# Geocoding API is the most informative probe for billing state. It returns HTTP 200
# with a JSON body whose error_message is explicit, for example:
#   "You must enable Billing on the Google Cloud Project at
#    https://console.cloud.google.com/project/_/billing/enable"
# The billing check fires even when the Geocoding API itself is not enabled, so this
# tells us the billing state of whichever project the key actually belongs to.
$geoUri = 'https://maps.googleapis.com/maps/api/geocode/json?address=Taipei&key=' + $key
Probe -Label 'PROBE 3: Geocoding API (most explicit billing signal)' -Uri $geoUri

# Differential referer test.
#
# KNOWN LIMITATION - THIS PROBE IS INCONCLUSIVE. Kept only to document the dead end.
#
# The idea was to call AuthenticationService.Authenticate (the internal endpoint the
# Maps JS API uses to decide whether a key may be used on the current page) with
# different Referer headers and compare responses.
#
# In practice all variants return the same NotLoadingAPIFromGoogleMapsError, because
# Google rejects the request for not coming through the real JS bootstrap flow before
# it ever evaluates the referer. So identical responses here prove nothing either way.
#
# Verifying referer restrictions requires either a real browser or authenticated
# access via gcloud. Do not draw conclusions from this probe.
function Probe-Referer {
    param([string]$Label, [string]$Referer)

    Write-Output ''
    Write-Output "--- referer: $Label ---"

    $uri = 'https://maps.googleapis.com/maps/api/js/AuthenticationService.Authenticate' +
           '?1s' + [System.Uri]::EscapeDataString($Referer) +
           '&4s' + $key +
           '&callback=cb'

    $headers = @{}
    if ($Referer -ne '') { $headers['Referer'] = $Referer }

    try {
        $r = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 30 -Headers $headers
        $body = $r.Content
        if ($body.Length -gt 300) { $body = $body.Substring(0, 300) + ' ...[truncated]' }
        Write-Output "HTTP $($r.StatusCode)  $($body.Replace($key, '<REDACTED>'))"
    }
    catch {
        $resp = $_.Exception.Response
        if ($null -eq $resp) {
            Write-Output "CONNECTION FAILED: $($_.Exception.Message)"
            return
        }
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $body = $reader.ReadToEnd()
        $reader.Close()
        if ($body.Length -gt 300) { $body = $body.Substring(0, 300) + ' ...[truncated]' }
        Write-Output "HTTP $([int]$resp.StatusCode)  $($body.Replace($key, '<REDACTED>'))"
    }
}

Write-Output ''
Write-Output '===== PROBE 4: differential referer test (INCONCLUSIVE - see comment) ====='
Probe-Referer -Label 'our dev server (should pass)' -Referer 'http://localhost:5173/'
Probe-Referer -Label 'unrelated domain (should fail if restricted)' -Referer 'https://example.invalid/'
Probe-Referer -Label 'none' -Referer ''

Write-Output ''
Write-Output '===== HOW TO READ THIS ====='
Write-Output 'Read PROBE 3 first. Its error_message distinguishes billing from API activation,'
Write-Output 'because the billing check runs BEFORE the per-API activation check.'
Write-Output ''
Write-Output 'PROBE 3 says "You must enable Billing on the Google Cloud Project"'
Write-Output '   -> billing is NOT linked. Fix that first, nothing else matters.'
Write-Output ''
Write-Output 'PROBE 3 says "This API is not activated on your API project"'
Write-Output '   -> BILLING IS FINE. This message is only about the Geocoding API, which this'
Write-Output '      project does not need. Treat it as a pass.'
Write-Output ''
Write-Output 'PROBE 3 says "API key not valid" / API_KEY_INVALID'
Write-Output '   -> the key itself is wrong, copy it again'
Write-Output ''
Write-Output 'Billing fine + key fine, but the browser still shows the darkened'
Write-Output '"for development purposes only" watermark. Two candidates:'
Write-Output ''
Write-Output '  1. HTTP referer restriction on the key. PROBE 4 cannot test this (see its'
Write-Output '     comment). Verify in the Console, or with: gcloud services api-keys list'
Write-Output '     Fix: Console > Credentials > edit key > Application restrictions > None'
Write-Output '     (to test), or add http://localhost:5173/*   Wait 5 min to propagate.'
Write-Output ''
Write-Output '  2. Billing account violation: Google Maps Platform forbids serving projects'
Write-Output '     when one account uses multiple billing accounts, and degrades them to the'
Write-Output '     same watermark. See https://developers.google.com/maps/billing-account-violation'
Write-Output '     Check this in the browser window signed in as the account that OWNS the key.'
Write-Output ''
Write-Output 'IMPORTANT: Cloud Console URLs follow whichever Google account the browser window'
Write-Output 'is signed in as. If the key was created in an incognito window under a different'
Write-Output 'account, you must check Credentials and Billing in THAT window, or you will be'
Write-Output 'looking at a completely different project.'

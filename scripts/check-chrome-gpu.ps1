# Find out why Chrome falls back to "Microsoft Basic Render Driver" on a machine whose
# GPU drivers are healthy.
#
# The two GPUs on this laptop (NVIDIA RTX 3050 + AMD Radeon iGPU) both report Status OK
# with current drivers, yet Chrome's WebGL renderer is the Microsoft Basic adapter. That
# is a Chrome-side or session-side problem, not a driver problem. The usual culprits:
#
#   1. Remote Desktop session   -> the session has a virtual display adapter, no GPU
#   2. HW acceleration disabled -> Chrome Settings > System
#   3. --disable-gpu passed on the command line, or a policy
#   4. Windows per-app graphics preference pointing at an unavailable GPU
#
# NOTE: ASCII only. Windows PowerShell 5.1 reads .ps1 as ANSI, so non-ASCII comments
# corrupt the parser.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\check-chrome-gpu.ps1

Write-Output '===== SESSION TYPE (Remote Desktop check) ====='
Write-Output "SESSIONNAME     : $env:SESSIONNAME"
Write-Output "CLIENTNAME      : $env:CLIENTNAME"

$isRemote = ($env:SESSIONNAME -like 'RDP-*') -or ($null -ne $env:CLIENTNAME -and $env:CLIENTNAME -ne '' -and $env:CLIENTNAME -ne 'Console')
if ($isRemote) {
    Write-Output 'VERDICT         : REMOTE SESSION DETECTED'
    Write-Output '  Remote Desktop gives the session a virtual display adapter. Chrome cannot'
    Write-Output '  reach the physical GPU, so WebGL falls back to the Microsoft Basic adapter.'
    Write-Output '  3D Maps cannot work over RDP. Use the laptop directly.'
}
else {
    Write-Output 'VERDICT         : looks like a local console session (good)'
}

Write-Output ''
Write-Output '===== RUNNING CHROME PROCESSES AND THEIR FLAGS ====='
$chrome = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue
if (-not $chrome) {
    Write-Output 'Chrome is not running.'
}
else {
    Write-Output "Chrome processes: $($chrome.Count)"
    # Only the browser process (the one without --type=) carries the interesting flags.
    $browser = $chrome | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' }
    foreach ($p in $browser) {
        Write-Output ''
        Write-Output "PID $($p.ProcessId):"
        Write-Output $p.CommandLine
    }

    $allCmd = ($chrome | ForEach-Object { $_.CommandLine }) -join ' '
    Write-Output ''
    Write-Output 'Flag scan:'
    foreach ($flag in @('--disable-gpu', '--disable-gpu-compositing', '--use-gl=swiftshader', '--disable-software-rasterizer', '--in-process-gpu')) {
        $present = if ($allCmd -match [regex]::Escape($flag)) { 'PRESENT' } else { 'absent' }
        Write-Output "  $flag : $present"
    }
}

Write-Output ''
Write-Output '===== CHROME HARDWARE ACCELERATION PREFERENCE ====='
# Chrome stores this in its Preferences JSON. hardware_acceleration_mode.enabled = false
# means the Settings > System toggle is off.
$prefPaths = @(
    "$env:LOCALAPPDATA\Google\Chrome\User Data\Default\Preferences",
    "$env:LOCALAPPDATA\Google\Chrome\User Data\Profile 1\Preferences"
)
foreach ($pref in $prefPaths) {
    if (-not (Test-Path $pref)) { continue }
    Write-Output ''
    Write-Output "Profile: $pref"
    try {
        $json = Get-Content $pref -Raw -Encoding UTF8 | ConvertFrom-Json
        $mode = $json.hardware_acceleration_mode
        if ($null -ne $mode) {
            Write-Output "  hardware_acceleration_mode.enabled = $($mode.enabled)"
            if ($mode.enabled -eq $false) {
                Write-Output '  >>> THIS IS THE PROBLEM. Turn it on in Settings > System, then relaunch Chrome.'
            }
        }
        else {
            Write-Output '  hardware_acceleration_mode not set (Chrome default is enabled)'
        }
    }
    catch {
        Write-Output "  could not parse: $($_.Exception.Message)"
    }
}

Write-Output ''
Write-Output '===== WINDOWS PER-APP GPU PREFERENCE ====='
$regPath = 'HKCU:\Software\Microsoft\DirectX\UserGpuPreferences'
if (Test-Path $regPath) {
    $prefs = Get-Item $regPath
    $names = $prefs.GetValueNames() | Where-Object { $_ -match 'chrome' }
    if ($names) {
        foreach ($n in $names) { Write-Output "  $n = $($prefs.GetValue($n))" }
        Write-Output '  (GpuPreference=1 means power saving / iGPU, 2 means high performance / dGPU)'
    }
    else {
        Write-Output '  no Chrome-specific preference set (Windows decides automatically)'
    }
}
else {
    Write-Output '  no per-app GPU preferences configured'
}

Write-Output ''
Write-Output '===== NEXT STEP ====='
Write-Output 'Open chrome://gpu in the browser. The "Graphics Feature Status" list and the'
Write-Output '"Problems Detected" section state exactly why Chrome refused the GPU. That page'
Write-Output 'is the ground truth and takes ten seconds to read.'

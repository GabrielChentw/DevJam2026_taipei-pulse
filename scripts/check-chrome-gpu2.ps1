# Distinguish cause from effect for Chrome's --disable-gpu flag.
#
# Chrome passes --disable-gpu / --disable-gpu-compositing DOWN to its child processes
# once the GPU has been turned off. So seeing those flags on a renderer proves nothing
# about why. What matters is:
#
#   - does the BROWSER process (the one with no --type=) carry the flag?  -> cause
#   - only children carry it?                                            -> effect
#   - is there an enterprise policy disabling hardware acceleration?      -> cause
#   - is there a persisted chrome://flags override?                       -> cause
#   - is a GPU process running at all?
#
# NOTE: ASCII only. Windows PowerShell 5.1 reads .ps1 as ANSI, so non-ASCII comments
# corrupt the parser.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\check-chrome-gpu2.ps1

$procs = @(Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" -ErrorAction SilentlyContinue)

Write-Output '===== PROCESS BREAKDOWN BY TYPE ====='
Write-Output ''

foreach ($p in $procs) {
    $cmd = $p.CommandLine
    if (-not $cmd) { continue }

    $type = 'BROWSER (root)'
    if ($cmd -match '--type=([a-zA-Z-]+)') { $type = $matches[1] }

    $hasDisableGpu = $cmd -match '--disable-gpu(?!-)'
    $hasDisableComp = $cmd -match '--disable-gpu-compositing'

    if ($type -eq 'BROWSER (root)' -or $type -eq 'gpu-process' -or $hasDisableGpu) {
        Write-Output "PID $($p.ProcessId)  type=$type"
        Write-Output "  --disable-gpu             : $(if ($hasDisableGpu) { 'YES' } else { 'no' })"
        Write-Output "  --disable-gpu-compositing : $(if ($hasDisableComp) { 'YES' } else { 'no' })"
        if ($type -eq 'BROWSER (root)') {
            Write-Output "  full: $cmd"
        }
        Write-Output ''
    }
}

$gpuProc = $procs | Where-Object { $_.CommandLine -match '--type=gpu-process' }
Write-Output "GPU process running : $(if ($gpuProc) { "YES (PID $($gpuProc.ProcessId -join ', '))" } else { 'NO' })"

$rootProcs = $procs | Where-Object { $_.CommandLine -and $_.CommandLine -notmatch '--type=' }
$rootWithFlag = $rootProcs | Where-Object { $_.CommandLine -match '--disable-gpu(?!-)' }

Write-Output ''
Write-Output '===== VERDICT ON THE FLAG ====='
if ($rootWithFlag) {
    Write-Output 'The BROWSER process itself carries --disable-gpu. This is the CAUSE.'
    Write-Output 'Something is launching Chrome with that flag: a shortcut, a script, or a'
    Write-Output 'parent application. Check the shortcut you use to start Chrome.'
}
else {
    Write-Output 'Only child processes carry the flag, so it is an EFFECT, not the cause.'
    Write-Output 'Chrome decided to disable the GPU by itself. chrome://gpu will say why.'
}

Write-Output ''
Write-Output '===== ENTERPRISE POLICY CHECK ====='
$policyKeys = @('HKLM:\SOFTWARE\Policies\Google\Chrome', 'HKCU:\SOFTWARE\Policies\Google\Chrome')
$foundPolicy = $false
foreach ($k in $policyKeys) {
    if (-not (Test-Path $k)) { continue }
    $item = Get-Item $k
    foreach ($n in $item.GetValueNames()) {
        Write-Output "  $k :: $n = $($item.GetValue($n))"
        $foundPolicy = $true
    }
}
if (-not $foundPolicy) { Write-Output '  no Chrome policies set' }

Write-Output ''
Write-Output '===== PERSISTED chrome://flags OVERRIDES ====='
foreach ($profile in @('Default', 'Profile 1')) {
    $localState = "$env:LOCALAPPDATA\Google\Chrome\User Data\Local State"
    if (-not (Test-Path $localState)) { continue }
    try {
        $json = Get-Content $localState -Raw -Encoding UTF8 | ConvertFrom-Json
        $labs = $json.browser.enabled_labs_experiments
        if ($labs) { Write-Output "  enabled_labs_experiments: $($labs -join ', ')" }
        else { Write-Output '  none' }
    }
    catch {
        Write-Output "  could not parse Local State: $($_.Exception.Message)"
    }
    break
}

Write-Output ''
Write-Output '===== PARENT OF THE ROOT CHROME PROCESS ====='
foreach ($p in $rootProcs) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)" -ErrorAction SilentlyContinue
    Write-Output "  chrome PID $($p.ProcessId) launched by: $(if ($parent) { "$($parent.Name) (PID $($parent.ProcessId))" } else { 'unknown / exited' })"
}

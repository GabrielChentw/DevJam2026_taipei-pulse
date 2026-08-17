# Determine whether this machine has a real GPU with a missing driver (fixable), or no
# GPU at all (not fixable, e.g. a VM without GPU passthrough).
#
# Context: Google Photorealistic 3D Maps requires hardware acceleration. When Chrome
# reports "Microsoft Basic Render Driver" as the WebGL renderer, no vendor GPU driver is
# active and 3D Maps cannot initialise, regardless of API key or version channel.
#
# NOTE: ASCII only. Windows PowerShell 5.1 reads .ps1 as ANSI, so non-ASCII comments
# corrupt the parser.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\check-gpu.ps1

Write-Output '===== COMPUTER SYSTEM ====='
Get-CimInstance Win32_ComputerSystem |
    Select-Object Manufacturer, Model, SystemFamily, TotalPhysicalMemory |
    Format-List

Write-Output '===== BIOS / VM HINTS ====='
Get-CimInstance Win32_BIOS | Select-Object Manufacturer, SMBIOSBIOSVersion, SerialNumber | Format-List

Write-Output '===== VIDEO CONTROLLERS (as Windows sees them) ====='
Get-CimInstance Win32_VideoController |
    Select-Object Name, VideoProcessor, DriverVersion, DriverDate, Status, AdapterRAM, PNPDeviceID |
    Format-List

Write-Output '===== ALL DISPLAY-CLASS PNP DEVICES (includes ones with no driver) ====='
Get-CimInstance Win32_PnPEntity |
    Where-Object { $_.PNPClass -eq 'Display' -or $_.Name -match 'VGA|Graphics|Video|Display' } |
    Select-Object Name, Status, ConfigManagerErrorCode, PNPDeviceID |
    Format-List

Write-Output '===== PROBLEM DEVICES (any class, driver missing or errored) ====='
$problems = Get-CimInstance Win32_PnPEntity | Where-Object { $_.ConfigManagerErrorCode -ne 0 }
if ($problems) {
    $problems | Select-Object Name, ConfigManagerErrorCode, PNPDeviceID | Format-List
}
else {
    Write-Output 'none'
}

Write-Output '===== HOW TO READ THIS ====='
Write-Output 'Manufacturer/Model naming a hypervisor (VMware, Microsoft Corporation Virtual'
Write-Output 'Machine, QEMU, Xen, VirtualBox, Google Compute Engine) means there is no'
Write-Output 'physical GPU to enable. Hardware acceleration is not achievable on this host.'
Write-Output ''
Write-Output 'A real GPU listed (Intel UHD/Iris, NVIDIA GeForce, AMD Radeon) but only'
Write-Output '"Microsoft Basic Display/Render" active means the vendor driver is missing.'
Write-Output 'Installing it fixes hardware acceleration.'
Write-Output ''
Write-Output 'PNPDeviceID starting with PCI\VEN_8086 = Intel, VEN_10DE = NVIDIA,'
Write-Output 'VEN_1002 = AMD, VEN_1414 = Microsoft (virtual).'

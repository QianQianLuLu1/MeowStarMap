# Post-reboot cleanup: delete locked win-unpacked, rename win-unpacked.tmp -> win-unpacked
# This script auto-runs once after reboot via HKCU\...\RunOnce

$ErrorActionPreference = 'Continue'
$projectRoot = 'H:\45001\Documents\WXNN XiangCe'
$winUnpacked = Join-Path $projectRoot 'build-output\win-unpacked'
$winUnpackedTmp = Join-Path $projectRoot 'build-output\win-unpacked.tmp'

$logFile = Join-Path $projectRoot 'build-output\post-reboot-cleanup.log'
$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Add-Content -Path $logFile -Value "[$stamp] post-reboot cleanup started"

# 1) Remove win-unpacked (should be unlocked now)
if (Test-Path $winUnpacked) {
    try {
        Remove-Item -Recurse -Force $winUnpacked -ErrorAction Stop
        Add-Content -Path $logFile -Value "[$stamp] removed win-unpacked"
    } catch {
        Add-Content -Path $logFile -Value "[$stamp] FAILED to remove win-unpacked: $_"
    }
} else {
    Add-Content -Path $logFile -Value "[$stamp] win-unpacked not found"
}

# 2) Rename win-unpacked.tmp -> win-unpacked
if (Test-Path $winUnpackedTmp) {
    try {
        Rename-Item -Path $winUnpackedTmp -NewName 'win-unpacked' -ErrorAction Stop
        Add-Content -Path $logFile -Value "[$stamp] renamed win-unpacked.tmp -> win-unpacked"
    } catch {
        Add-Content -Path $logFile -Value "[$stamp] FAILED to rename: $_"
    }
} else {
    Add-Content -Path $logFile -Value "[$stamp] win-unpacked.tmp not found"
}

# 3) Show notification
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show(
    'Build output cleanup complete. You can now run: npm run dist',
    'Post-Reboot Cleanup',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Information
) | Out-Null

Add-Content -Path $logFile -Value "[$stamp] post-reboot cleanup done"

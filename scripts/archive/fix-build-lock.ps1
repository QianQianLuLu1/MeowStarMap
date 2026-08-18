# Fix electron-builder EPERM rename error
# Cause: build-output\win-unpacked is locked, cannot be replaced by win-unpacked.tmp
# Common lockers: previous build exe still running / Explorer opened the dir / AV scanning

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$buildOutput = Join-Path $projectRoot 'build-output'
$winUnpacked = Join-Path $buildOutput 'win-unpacked'
$winUnpackedTmp = Join-Path $buildOutput 'win-unpacked.tmp'

Write-Host '=== Build output directory status ===' -ForegroundColor Cyan
Write-Host ("win-unpacked      : " + $(if (Test-Path $winUnpacked) { 'EXISTS' } else { 'MISSING' }))
Write-Host ("win-unpacked.tmp  : " + $(if (Test-Path $winUnpackedTmp) { 'EXISTS' } else { 'MISSING' }))

# 1) Find processes that may be locking win-unpacked
Write-Host ''
Write-Host '=== Check locking processes ===' -ForegroundColor Cyan

$suspectNames = @('wxnn-photo-manager', 'electron', 'NikkiGallery')

$lockingProcs = @()
$allProcs = Get-CimInstance Win32_Process
foreach ($proc in $allProcs) {
    $matched = $false
    if ($proc.ExecutablePath -and $proc.ExecutablePath -like "$win-unpacked*") {
        $matched = $true
    }
    if (-not $matched) {
        foreach ($name in $suspectNames) {
            if ($proc.Name -and $proc.Name -like "*$name*") {
                $matched = $true
                break
            }
        }
    }
    if ($matched) {
        $lockingProcs += [PSCustomObject]@{
            Id        = $proc.ProcessId
            Name      = $proc.Name
            Path      = $proc.ExecutablePath
            IsCurrent = ($proc.ProcessId -eq $PID)
        }
    }
}

if ($lockingProcs.Count -eq 0) {
    Write-Host 'No obvious locking process found' -ForegroundColor Green
} else {
    Write-Host ("Found " + $lockingProcs.Count + " suspect process(es):") -ForegroundColor Yellow
    $lockingProcs | Format-Table -AutoSize
}

# 2) Auto-kill locking processes only when -y is passed
$autoKill = $false
if ($args.Count -gt 0 -and $args[0] -eq '-y') { $autoKill = $true }

if ($lockingProcs.Count -gt 0) {
    if ($autoKill) {
        foreach ($p in $lockingProcs) {
            if ($p.IsCurrent) {
                Write-Host ("Skip current PowerShell PID=" + $p.Id) -ForegroundColor Gray
                continue
            }
            try {
                Stop-Process -Id $p.Id -Force -ErrorAction Stop
                Write-Host ("Killed PID=" + $p.Id + " " + $p.Name) -ForegroundColor Green
            } catch {
                Write-Host ("Failed to kill PID=" + $p.Id + " " + $p.Name + " : " + $_) -ForegroundColor Red
            }
        }
        Start-Sleep -Milliseconds 800
    } else {
        Write-Host 'Locking processes detected but -y not specified. Run with -y to auto-kill:' -ForegroundColor Yellow
        Write-Host '  powershell -File scripts\fix-build-lock.ps1 -y' -ForegroundColor Gray
        exit 2
    }
}

# 3) Remove the old win-unpacked directory
if (Test-Path $winUnpacked) {
    Write-Host ''
    Write-Host '=== Remove old win-unpacked ===' -ForegroundColor Cyan
    try {
        Remove-Item -Recurse -Force $winUnpacked -ErrorAction Stop
        Write-Host 'Removed win-unpacked' -ForegroundColor Green
    } catch {
        Write-Host ("Remove failed: " + $_) -ForegroundColor Red
        Write-Host 'Directory may still be locked. Close Explorer windows / AV real-time scan and retry.' -ForegroundColor Yellow
        Write-Host 'Or reboot and immediately retry build before opening any app.' -ForegroundColor Yellow
        exit 1
    }
}

# 4) Rename win-unpacked.tmp -> win-unpacked (if exists)
if (Test-Path $winUnpackedTmp) {
    Write-Host ''
    Write-Host '=== Rename win-unpacked.tmp -> win-unpacked ===' -ForegroundColor Cyan
    try {
        Rename-Item -Path $winUnpackedTmp -NewName 'win-unpacked' -ErrorAction Stop
        Write-Host 'Rename OK. You can now run: npm run dist' -ForegroundColor Green
    } catch {
        Write-Host ("Rename failed: " + $_) -ForegroundColor Red
        Write-Host 'Please manually delete win-unpacked.tmp then run: npm run dist' -ForegroundColor Yellow
        exit 1
    }
} else {
    Write-Host ''
    Write-Host 'win-unpacked.tmp not found, just run: npm run dist' -ForegroundColor Green
}

Write-Host ''
Write-Host '=== Done ===' -ForegroundColor Green

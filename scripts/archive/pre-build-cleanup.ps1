# Pre-build cleanup script
# Step 1: Kill electron / app processes (excluding TRAE SOLO CN, agent-tool-host, trae-sandbox, codegraph)
# Step 2: Delete build-output\win-unpacked and build-output\win-unpacked.tmp
# Step 3: Delete build-output_old_205365928

$ErrorActionPreference = 'Continue'
$projectRoot = 'H:\45001\Documents\WXNN XiangCe'
$buildOutput = Join-Path $projectRoot 'build-output'

# TRAE-related process names that must NEVER be killed
$traeNames = @(
    'TRAE SOLO CN',
    'agent-tool-host',
    'trae-sandbox',
    'codegraph',
    'WindowsTerminal',
    'OpenConsole',
    'conhost'
)

# Target process names to kill
$targetNames = @(
    'electron',
    'wxnn-photo-manager',
    'NikkiGallery'
)

# Chinese app name (cannot be matched via -Name, use CIM)
$chineseAppName = '无限暖暖相册管理工具'

# ============ Step 1: Kill processes ============
Write-Host '=======================================' -ForegroundColor Cyan
Write-Host 'Step 1: Kill electron / app processes (excluding TRAE)' -ForegroundColor Cyan
Write-Host '=======================================' -ForegroundColor Cyan

$killed = 0
$skipped = 0
$failed = 0

# Build a set of TRAE process names (lowercase for comparison)
$traeNamesLower = $traeNames | ForEach-Object { $_.ToLower() }

# Get all processes
$allProcs = Get-CimInstance Win32_Process
foreach ($proc in $allProcs) {
    $procName = $proc.Name
    if (-not $procName) { continue }
    $procNameLower = $procName.ToLower()
    $exePath = $proc.ExecutablePath
    if (-not $exePath) { $exePath = '' }

    $isTrae = $false
    foreach ($t in $traeNamesLower) {
        if ($procNameLower -like "*$t*") { $isTrae = $true; break }
    }
    # Also treat anything under H:\TRAE SOLO CN as TRAE
    if (-not $isTrae -and $exePath -like '*TRAE SOLO CN*') { $isTrae = $true }
    # codegraph under AppData
    if (-not $isTrae -and $exePath -like '*codegraph*') { $isTrae = $true }

    $isTarget = $false
    foreach ($t in $targetNames) {
        if ($procNameLower -like "*$t*") { $isTarget = $true; break }
    }
    # Chinese app name match
    if (-not $isTarget -and $procName -like "*$chineseAppName*") { $isTarget = $true }
    # Anything under build-output\win-unpacked is the previous build's app
    if (-not $isTarget -and $exePath -like "*$buildOutput\win-unpacked*") { $isTarget = $true }
    # Also the installed location H:\QNXC\wxnn-photo-manager
    if (-not $isTarget -and $exePath -like '*QNXC\wxnn-photo-manager*') { $isTarget = $true }

    # Skip TRAE processes even if they look like targets
    if ($isTrae -and $isTarget) {
        Write-Host ("  SKIP (TRAE): PID=" + $proc.ProcessId + " " + $procName) -ForegroundColor Gray
        $skipped++
        continue
    }

    if ($isTarget) {
        Write-Host ("  KILL: PID=" + $proc.ProcessId + " " + $procName + "  EXE=" + $exePath) -ForegroundColor Yellow
        try {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
            Write-Host ("    killed") -ForegroundColor Green
            $killed++
        } catch {
            Write-Host ("    FAILED: " + $_.Exception.Message) -ForegroundColor Red
            $failed++
        }
    }
}

Write-Host ''
Write-Host ("Step 1 result: killed=" + $killed + "  skipped(TRAE)=" + $skipped + "  failed=" + $failed) -ForegroundColor Green
Write-Host ''

# Wait a moment for handles to release
Start-Sleep -Seconds 2

# ============ Step 2: Delete win-unpacked and win-unpacked.tmp ============
Write-Host '=======================================' -ForegroundColor Cyan
Write-Host 'Step 2: Delete win-unpacked and win-unpacked.tmp' -ForegroundColor Cyan
Write-Host '=======================================' -ForegroundColor Cyan

$targets = @(
    (Join-Path $buildOutput 'win-unpacked'),
    (Join-Path $buildOutput 'win-unpacked.tmp')
)

foreach ($target in $targets) {
    if (Test-Path $target) {
        Write-Host ("Deleting: " + $target)
        $deleted = $false
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            try {
                Remove-Item -Recurse -Force $target -ErrorAction Stop
                Write-Host ("  deleted (attempt " + $attempt + ")") -ForegroundColor Green
                $deleted = $true
                break
            } catch {
                Write-Host ("  attempt " + $attempt + " failed: " + $_.Exception.Message) -ForegroundColor Yellow
                if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
            }
        }
        if (-not $deleted) {
            Write-Host ("  FAILED to delete after 3 attempts") -ForegroundColor Red
        }
    } else {
        Write-Host ("Not present (skip): " + $target) -ForegroundColor Gray
    }
}

Write-Host ''

# ============ Step 3: Delete build-output_old_205365928 ============
Write-Host '=======================================' -ForegroundColor Cyan
Write-Host 'Step 3: Delete build-output_old_205365928' -ForegroundColor Cyan
Write-Host '=======================================' -ForegroundColor Cyan

$oldDir = Join-Path $projectRoot 'build-output_old_205365928'
if (Test-Path $oldDir) {
    Write-Host ("Deleting: " + $oldDir)
    try {
        Remove-Item -Recurse -Force $oldDir -ErrorAction Stop
        Write-Host ("  deleted") -ForegroundColor Green
    } catch {
        Write-Host ("  FAILED: " + $_.Exception.Message) -ForegroundColor Red
    }
} else {
    Write-Host ("Not present (skip): " + $oldDir) -ForegroundColor Gray
}

Write-Host ''
Write-Host '=======================================' -ForegroundColor Green
Write-Host 'Cleanup complete' -ForegroundColor Green
Write-Host '=======================================' -ForegroundColor Green

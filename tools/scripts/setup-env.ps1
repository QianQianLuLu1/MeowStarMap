# TRAE IDE starts PowerShell with -NoProfile, so $PROFILE is not loaded.
# This script manually loads fnm env to switch Node to v20 LTS for this project.
# Usage in a new TRAE terminal session:  . .\setup-env.ps1  (or just  .\setup-env.ps1)

$fnmExe = Get-Command fnm -ErrorAction SilentlyContinue
if (-not $fnmExe) {
    $wingetLinks = "C:\Users\45001\AppData\Local\Microsoft\WinGet\Links"
    if (Test-Path "$wingetLinks\fnm.exe") {
        $env:PATH = "$env:PATH;$wingetLinks"
    } else {
        Write-Host "[setup-env] fnm not installed. Run: winget install Schniz.fnm" -ForegroundColor Red
        return
    }
}

fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression

$nodeVer = node -v 2>$null
if ($nodeVer -notmatch '^v20\.') {
    Write-Host "[setup-env] WARNING: Node version is $nodeVer, project requires v20 LTS" -ForegroundColor Yellow
} else {
    Write-Host "[setup-env] fnm loaded. Node: $nodeVer" -ForegroundColor Green
}

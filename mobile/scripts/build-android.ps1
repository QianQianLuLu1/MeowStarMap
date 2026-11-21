param(
    [switch]$Install,
    [switch]$CheckOnly,
    [string]$JavaHome = $env:JAVA_HOME,
    [string]$AndroidSdk = $(if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }),
    [string]$GradleBat = ''
)

$ErrorActionPreference = 'Stop'
if (-not $JavaHome) { throw 'Set JAVA_HOME to JDK 17 or pass -JavaHome before building.' }
$mobileRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$apk = Join-Path $mobileRoot 'app\build\outputs\apk\debug\app-debug.apk'
$buildTools = Join-Path $AndroidSdk 'build-tools\35.0.1'
$adb = Join-Path $AndroidSdk 'platform-tools\adb.exe'
if (-not $GradleBat) {
    $projectWrapper = Join-Path $mobileRoot 'gradlew.bat'
    $GradleBat = if (Test-Path -LiteralPath $projectWrapper -PathType Leaf) {
        $projectWrapper
    } else {
        $command = Get-Command gradle.bat -ErrorAction SilentlyContinue
        if (-not $command) { throw 'Gradle wrapper is missing; pass -GradleBat or install Gradle on PATH.' }
        $command.Source
    }
}
$required = @(
    (Join-Path $JavaHome 'bin\java.exe'),
    $GradleBat,
    $adb,
    (Join-Path $AndroidSdk 'platforms\android-35\android.jar'),
    (Join-Path $buildTools 'aapt.exe'),
    (Join-Path $buildTools 'apksigner.bat')
)

foreach ($item in $required) {
    if (-not (Test-Path -LiteralPath $item -PathType Leaf)) {
        throw "Android build dependency is missing: $item"
    }
}

$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = $AndroidSdk
$env:ANDROID_SDK_ROOT = $AndroidSdk
$env:Path = (Join-Path $JavaHome 'bin') + ';' + (Join-Path $AndroidSdk 'platform-tools') + ';' + $env:Path

if ($CheckOnly) {
    Write-Host 'CHECK PASSED: JDK 17, Android SDK 35, adb, Build Tools 35.0.1, and Gradle 8.13 are available.' -ForegroundColor Green
    exit 0
}

Write-Host 'Building MeowStarMap Android debug APK...' -ForegroundColor Cyan
Write-Host "Project: $mobileRoot"
& $GradleBat -p $mobileRoot --no-daemon :app:assembleDebug
if ($LASTEXITCODE -ne 0) { throw "Gradle build failed with exit code $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $apk -PathType Leaf)) { throw "Gradle reported success but APK was not found: $apk" }

& (Join-Path $buildTools 'apksigner.bat') verify --verbose $apk
if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
$badging = & (Join-Path $buildTools 'aapt.exe') dump badging $apk
if ($LASTEXITCODE -ne 0 -or -not ($badging -match "package: name='com.qianlu.meowstarmap'")) {
    throw 'APK package-id verification failed.'
}
$file = Get-Item -LiteralPath $apk
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $stream = [System.IO.File]::OpenRead($apk)
    try {
        $hash = -join ($sha256.ComputeHash($stream) | ForEach-Object { $_.ToString('X2') })
    } finally {
        $stream.Dispose()
    }
} finally {
    $sha256.Dispose()
}
Write-Host ''
Write-Host 'APK BUILD PASSED' -ForegroundColor Green
Write-Host "APK:    $apk"
Write-Host "Size:   $([Math]::Round($file.Length / 1MB, 2)) MB"
Write-Host "SHA256: $hash"

if ($Install) {
    $devices = & $adb devices
    if (-not ($devices -match "`tdevice")) {
        throw 'No authorized Android device is connected. Enable USB debugging and authorize this computer.'
    }
    & $adb install -r $apk
    if ($LASTEXITCODE -ne 0) { throw "ADB installation failed with exit code $LASTEXITCODE" }
    Write-Host '喵星图 was installed on the connected Android device.' -ForegroundColor Green
}

param(
  [switch]$ExtractOnly
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$PackageJson = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
# Electrobun builds for the machine it runs on: win-x64, or win-arm64 on
# Windows on Arm. The build's update manifest says which it made.
$Manifest = Get-ChildItem -LiteralPath (Join-Path $Root "artifacts") -Filter "stable-win-*-update.json" -ErrorAction SilentlyContinue | Select-Object -First 1
$Platform = if ($Manifest -and $Manifest.Name -match '^stable-(win-(x64|arm64))-update\.json$') { $Matches[1] } elseif ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "win-arm64" } else { "win-x64" }
$Arch = $Platform.Substring("win-".Length)
$ArchivePath = Join-Path $Root "artifacts\stable-$Platform-Gloom.tar.zst"
$ExtractRoot = Join-Path $Root "build\stable-$Platform\Gloom-inno-source"
$SourceDir = Join-Path $ExtractRoot "Gloom"
$OutputDir = Join-Path $Root "artifacts"
$InstallerScript = Join-Path $Root "scripts\windows-installer.iss"

if (-not (Test-Path $ArchivePath)) {
  throw "Windows desktop bundle archive not found: $ArchivePath"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

if (Test-Path $ExtractRoot) {
  Remove-Item -Recurse -Force $ExtractRoot
}
New-Item -ItemType Directory -Force -Path $ExtractRoot | Out-Null

# The zig-zstd the build ships in the app.
$Zstd = Join-Path $Root "build\stable-$Platform\Gloom\bin\zig-zstd.exe"
if (-not (Test-Path $Zstd)) {
  throw "zig-zstd.exe was not found: $Zstd"
}

$TarPath = Join-Path $ExtractRoot "Gloom.tar"
& $Zstd decompress -i $ArchivePath -o $TarPath
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

tar -xf $TarPath -C $ExtractRoot
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
Remove-Item -Force $TarPath

if (-not (Test-Path $SourceDir)) {
  throw "Windows desktop bundle was not extracted: $SourceDir"
}

$Launcher = Join-Path $SourceDir "bin\launcher"
$LauncherExe = Join-Path $SourceDir "bin\launcher.exe"
if ((Test-Path $Launcher) -and (-not (Test-Path $LauncherExe))) {
  Rename-Item -Path $Launcher -NewName "launcher.exe"
}

if ($ExtractOnly) {
  Write-Host "Extracted Windows desktop package: $SourceDir"
  return
}

$Candidates = @()
if ($env:ISCC_EXE) {
  $Candidates += $env:ISCC_EXE
}
$Candidates += @(
  "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
  "${env:ProgramFiles}\Inno Setup 6\ISCC.exe"
)

$Iscc = $Candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $Iscc) {
  throw "ISCC.exe was not found. Install Inno Setup 6 or set ISCC_EXE."
}

& $Iscc `
  "/DAppVersion=$($PackageJson.version)" `
  "/DArch=$Arch" `
  "/DSourceDir=$SourceDir" `
  "/DOutputDir=$OutputDir" `
  $InstallerScript

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

$InstallerPath = Join-Path $OutputDir "GloomSetup.exe"
if (-not (Test-Path $InstallerPath)) {
  throw "Expected installer was not created: $InstallerPath"
}

$PrefixedInstallerPath = Join-Path $OutputDir "stable-$Platform-GloomSetup.exe"
Copy-Item -Force $InstallerPath $PrefixedInstallerPath
Write-Host "Created installer: $PrefixedInstallerPath"

param(
  [switch]$ExtractOnly
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$PackageJson = Get-Content (Join-Path $Root "package.json") -Raw | ConvertFrom-Json
$ArchivePath = Join-Path $Root "artifacts\stable-win-x64-Gloom.tar.zst"
$ExtractRoot = Join-Path $Root "build\stable-win-x64\Gloom-inno-source"
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

$Zstd = Join-Path $Root "node_modules\electrobun\dist-win-x64\zig-zstd.exe"
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

$PrefixedInstallerPath = Join-Path $OutputDir "stable-win-x64-GloomSetup.exe"
Copy-Item -Force $InstallerPath $PrefixedInstallerPath
Write-Host "Created installer: $PrefixedInstallerPath"

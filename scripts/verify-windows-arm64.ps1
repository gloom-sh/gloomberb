$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$BundleDir = Join-Path $Root "build\stable-win-x64\Gloomberb-inno-source\Gloomberb"
$InstallerPath = Join-Path $Root "artifacts\stable-win-x64-GloomberbSetup.exe"
$BundledCli = Join-Path $BundleDir "bin\gloomberb.cmd"
$BundledNativeDir = Join-Path $BundleDir "Resources\gloomberb-tui\node_modules\@opentui\core-win32-x64"
$InstallDir = Join-Path $env:TEMP "GloomberbArm64Install-$PID"
$InstallLog = Join-Path $env:TEMP "gloomberb-arm64-install-$PID.log"
$UninstallLog = Join-Path $env:TEMP "gloomberb-arm64-uninstall-$PID.log"
$GuiStdoutLog = Join-Path $env:TEMP "gloomberb-arm64-gui-stdout-$PID.log"
$GuiStderrLog = Join-Path $env:TEMP "gloomberb-arm64-gui-stderr-$PID.log"
$OriginalLocalAppData = $env:LOCALAPPDATA
$IsolatedLocalAppData = Join-Path $env:TEMP "GloomberbArm64LocalAppData-$PID"
$DesktopProfileDir = Join-Path $IsolatedLocalAppData "com.vincelwt.gloomberb"

function Assert-CommandSucceeds {
  param(
    [string]$Path,
    [string[]]$Arguments
  )

  & $Path @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code $LASTEXITCODE`: $Path $($Arguments -join ' ')"
  }
}

$RuntimeArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
if ($RuntimeArchitecture -ne [System.Runtime.InteropServices.Architecture]::Arm64) {
  throw "Windows ARM64 verification requires an ARM64 runner, got $RuntimeArchitecture"
}

foreach ($Path in @($InstallerPath, $BundledCli, $BundledNativeDir)) {
  if (-not (Test-Path $Path)) {
    throw "Missing Windows desktop package path: $Path"
  }
}

$NativeLibraries = Get-ChildItem -Path $BundledNativeDir -Filter "*.dll" -File -ErrorAction SilentlyContinue
if (-not $NativeLibraries) {
  throw "Missing bundled OpenTUI x64 native library: $BundledNativeDir"
}

Assert-CommandSucceeds $BundledCli @("__gloomberb-smoke-opentui-native")
Assert-CommandSucceeds $BundledCli @("help")

$GuiProcess = $null
$PackageProcessIds = @()

try {
  if (Test-Path $InstallDir) {
    Remove-Item -Path $InstallDir -Recurse -Force
  }

  $InstallProcess = Start-Process `
    -FilePath $InstallerPath `
    -ArgumentList @(
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
      "/CURRENTUSER",
      "/DIR=$InstallDir",
      "/LOG=$InstallLog"
    ) `
    -Wait `
    -PassThru
  if ($InstallProcess.ExitCode -ne 0) {
    Get-Content $InstallLog -ErrorAction SilentlyContinue
    throw "Windows ARM64 installer smoke failed with exit code $($InstallProcess.ExitCode)"
  }

  $InstalledCli = Join-Path $InstallDir "bin\gloomberb.cmd"
  $InstalledLauncher = Join-Path $InstallDir "bin\launcher.exe"
  foreach ($Path in @($InstalledCli, $InstalledLauncher)) {
    if (-not (Test-Path $Path)) {
      throw "Missing installed Windows desktop path: $Path"
    }
  }

  Assert-CommandSucceeds $InstalledCli @("__gloomberb-smoke-opentui-native")
  Assert-CommandSucceeds $InstalledCli @("help")

  Remove-Item -Path $IsolatedLocalAppData -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $IsolatedLocalAppData -Force | Out-Null
  $env:LOCALAPPDATA = $IsolatedLocalAppData
  Remove-Item -Path $DesktopProfileDir -Recurse -Force -ErrorAction SilentlyContinue

  $env:ELECTROBUN_CONSOLE = "1"
  $GuiProcess = Start-Process `
    -FilePath $InstalledLauncher `
    -WorkingDirectory (Join-Path $InstallDir "bin") `
    -RedirectStandardOutput $GuiStdoutLog `
    -RedirectStandardError $GuiStderrLog `
    -PassThru
  Start-Sleep -Seconds 15
  $GuiProcess.Refresh()

  $PackageProcesses = @(
    Get-CimInstance Win32_Process |
      Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($InstallDir, [System.StringComparison]::OrdinalIgnoreCase) }
  )
  $PackageProcessIds = @($PackageProcesses | Select-Object -ExpandProperty ProcessId)
  if ($GuiProcess.HasExited -and $GuiProcess.ExitCode -ne 0) {
    Get-Content $GuiStdoutLog -ErrorAction SilentlyContinue
    Get-Content $GuiStderrLog -ErrorAction SilentlyContinue
    throw "Windows ARM64 desktop GUI exited with code $($GuiProcess.ExitCode)"
  }
  if ($GuiProcess.HasExited -and $PackageProcesses.Count -eq 0) {
    Get-Content $GuiStdoutLog -ErrorAction SilentlyContinue
    Get-Content $GuiStderrLog -ErrorAction SilentlyContinue
    throw "Windows ARM64 desktop GUI did not remain running after launch"
  }

  Write-Host "Windows ARM64 desktop compatibility smoke passed with $($PackageProcesses.Count) package process(es)."
} finally {
  foreach ($ProcessId in $PackageProcessIds) {
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
  if ($GuiProcess -and -not $GuiProcess.HasExited) {
    Stop-Process -Id $GuiProcess.Id -Force -ErrorAction SilentlyContinue
  }
  $env:LOCALAPPDATA = $OriginalLocalAppData

  $Uninstaller = Get-ChildItem -Path $InstallDir -Filter "unins*.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($Uninstaller) {
    $UninstallProcess = Start-Process `
      -FilePath $Uninstaller.FullName `
      -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=$UninstallLog") `
      -Wait `
      -PassThru
    if ($UninstallProcess.ExitCode -ne 0) {
      Get-Content $UninstallLog -ErrorAction SilentlyContinue
      throw "Windows ARM64 uninstall smoke failed with exit code $($UninstallProcess.ExitCode)"
    }
  }

  Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $IsolatedLocalAppData -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $GuiStdoutLog, $GuiStderrLog -Force -ErrorAction SilentlyContinue
}

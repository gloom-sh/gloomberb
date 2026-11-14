# Installs the desktop app from an installer the way a user does (per user,
# silently), and reports where it went, the installer's size and the
# installed folder's, as a step output (`folder`) and in sizes.md.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$Label = "app",
  [string]$Out = "sizes.md"
)

$ErrorActionPreference = "Stop"
$env:GLOOMBERB_NO_TELEMETRY = "1"
$env:DO_NOT_TRACK = "1"
$Watch = [System.Diagnostics.Stopwatch]::StartNew()
$Install = Start-Process -FilePath $Installer -Wait -PassThru -ArgumentList "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER"
$InstallMs = $Watch.ElapsedMilliseconds
if ($Install.ExitCode -ne 0) { throw "The installer failed: $($Install.ExitCode)" }

# This build's installer installs into Electrobun's folder; an earlier one
# into its own, which its uninstall entry names.
$Folder = Join-Path $env:LOCALAPPDATA "com.vincelwt.gloomberb\stable\app"
$Entry = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{D7B2304C-840B-4E5F-956A-3D1C66E67B35}_is1" -ErrorAction SilentlyContinue
if ($Entry -and $Entry."Inno Setup: App Path") { $Folder = $Entry."Inno Setup: App Path".TrimEnd("\") }
if (-not (Test-Path -LiteralPath (Join-Path $Folder "bin\launcher.exe"))) { throw "No app in $Folder after the install" }
$Bytes = (Get-ChildItem -LiteralPath $Folder -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum
$InstallerBytes = (Get-Item -LiteralPath $Installer).Length
$Build = Get-Content -LiteralPath (Join-Path $Folder "Resources\build.json") -Raw | ConvertFrom-Json

$Lines = @(
  "| $Label | $InstallerBytes | $Bytes | $InstallMs | $(if ($Build.electrobunVersion) { $Build.electrobunVersion } else { "1.x" }) | $(@($Build.availableRenderers) -join ' ') | $Folder |"
)
if (-not (Test-Path -LiteralPath $Out)) {
  @("| install | installer bytes | installed bytes | silent install ms | Electrobun | renderers | folder |", "|---|---|---|---|---|---|---|") | Set-Content -LiteralPath $Out
}
$Lines | Add-Content -LiteralPath $Out
$Lines | ForEach-Object { Write-Host $_ }
"folder=$Folder" | Add-Content -LiteralPath $env:GITHUB_OUTPUT

# Installs the desktop app from its installer the way a user does (per user,
# silently), times it, and reports the installed folder and its size.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$NamePattern = "Gloom*",
  [string]$Arguments = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CURRENTUSER"
)

$ErrorActionPreference = "Stop"
$Watch = [System.Diagnostics.Stopwatch]::StartNew()
if ($Installer.EndsWith(".msi")) {
  $Install = Start-Process -FilePath "msiexec.exe" -Wait -PassThru -ArgumentList @("/i", "`"$((Resolve-Path $Installer).Path)`"", "/qn")
} else {
  $Install = Start-Process -FilePath $Installer -Wait -PassThru -ArgumentList $Arguments
}
$InstallMs = $Watch.ElapsedMilliseconds
if ($Install.ExitCode -ne 0) { throw "The installer failed: $($Install.ExitCode)" }

$Keys = @()
foreach ($Root in @("HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall")) {
  $Keys += @(Get-ChildItem $Root -ErrorAction SilentlyContinue | ForEach-Object { Get-ItemProperty $_.PSPath } |
    Where-Object { $_.DisplayName -like $NamePattern })
}
if ($Keys.Count -eq 0) { throw "The installer left no uninstall entry matching $NamePattern" }
$Entry = $Keys | Select-Object -Last 1
# NSIS installers quote the location.
$Folder = "$($Entry.InstallLocation)" -replace '"', ''
if ((-not $Folder -or -not (Test-Path -LiteralPath $Folder)) -and $Entry.DisplayIcon) { $Folder = Split-Path ($Entry.DisplayIcon -replace '"', '' -replace ',\d+$', '') }
if ((-not $Folder -or -not (Test-Path -LiteralPath $Folder)) -and $Entry.UninstallString) { $Folder = Split-Path ($Entry.UninstallString -replace '"', '' -replace ' /.*$', '') }
$Folder = $Folder.TrimEnd("\")
Write-Host "Uninstall entry: $($Entry | Select-Object DisplayName, InstallLocation, DisplayIcon, UninstallString | Format-List | Out-String)"
$Bytes = (Get-ChildItem -LiteralPath $Folder -Recurse -File -Force | Measure-Object -Property Length -Sum).Sum
$InstallerBytes = (Get-Item -LiteralPath $Installer).Length

$Lines = @(
  "## Sizes",
  "",
  "| item | value |",
  "|---|---|",
  "| installer ($(Split-Path -Leaf $Installer)) bytes | $InstallerBytes |",
  "| installed folder bytes | $Bytes |",
  "| silent install ms | $InstallMs |",
  "| installed at | $Folder |"
)
Get-ChildItem -LiteralPath (Split-Path $Installer) -File | ForEach-Object { $Lines += "| artifact $($_.Name) bytes | $($_.Length) |" }
if (Test-Path artifacts) { Get-ChildItem -LiteralPath artifacts -File | ForEach-Object { $Lines += "| artifact $($_.Name) bytes | $($_.Length) |" } }
$Lines | Set-Content -LiteralPath sizes.md
$Lines | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY
$Lines | ForEach-Object { Write-Host $_ }
"folder=$Folder" | Add-Content -LiteralPath $env:GITHUB_OUTPUT

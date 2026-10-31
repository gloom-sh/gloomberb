# Repro only, not for main. Repeats the update check's step 3 many times:
# with the app stopped, a copy of it goes into the updater's folder, with the
# shortcut and uninstall entry Electrobun's setup makes for it, and the app is
# opened from the Start menu shortcut. Records how every app process ends,
# keeps Windows' minidumps of any crash and names the crash's stack.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [int]$Launches = 15,
  [int]$Seconds = 20,
  # Without this, each launch follows a stop only, as the update check's step 2 does.
  [switch]$Copy,
  # A line of JS run first in the installed Resources\main.js.
  [string]$Prelude = "",
  [string]$Label = "repro",
  [string]$EvidenceDir = (Join-Path (Get-Location) "artifacts\windows-update-launch-repro")
)

$ErrorActionPreference = "Stop"
$Evidence = Join-Path $EvidenceDir $Label
New-Item -ItemType Directory -Force -Path $Evidence | Out-Null
$Report = Join-Path $Evidence "report.txt"
$Programs = @("launcher.exe", "bun.exe", "bun Helper.exe")

function Write-Line {
  param([string]$Text)
  $Line = "[{0:HH:mm:ss.fff}] {1}" -f (Get-Date), $Text
  Write-Host $Line
  Add-Content -LiteralPath $Report -Value $Line
}

function Get-ProcessesUnder {
  param([string]$Folder)
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and $_.Path.StartsWith("$Folder\", [StringComparison]::OrdinalIgnoreCase) } catch { $false }
  })
}

function Stop-ProcessesUnder {
  param([string[]]$Folders)
  foreach ($Folder in $Folders) { Get-ProcessesUnder $Folder | Stop-Process -Force -ErrorAction SilentlyContinue }
  for ($Attempt = 0; $Attempt -lt 20; $Attempt += 1) {
    if (@($Folders | ForEach-Object { Get-ProcessesUnder $_ }).Count -eq 0) { return }
    Start-Sleep -Milliseconds 500
  }
}

# Windows Error Reporting is off on the runner image, and with it LocalDumps.
$WerKey = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting"
$WerPolicy = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Error Reporting"
try {
  New-Item -Force -Path $WerKey -ErrorAction SilentlyContinue | Out-Null
  Set-ItemProperty -LiteralPath $WerKey -Name Disabled -Value 0 -Type DWord
  Set-ItemProperty -LiteralPath $WerKey -Name DontShowUI -Value 1 -Type DWord
  if (Test-Path -LiteralPath $WerPolicy) { Remove-ItemProperty -LiteralPath $WerPolicy -Name Disabled -ErrorAction SilentlyContinue }
  Set-Service WerSvc -StartupType Manual -ErrorAction SilentlyContinue
  Start-Service WerSvc -ErrorAction SilentlyContinue
} catch {
  Write-Line "could not switch WER on: $($_.Exception.Message)"
}
$DumpDir = Join-Path $Evidence "dumps"
New-Item -ItemType Directory -Force -Path $DumpDir | Out-Null
foreach ($Program in $Programs) {
  $Key = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\$Program"
  New-Item -Force -Path $Key | Out-Null
  Set-ItemProperty -Path $Key -Name DumpFolder -Value $DumpDir -Type ExpandString
  Set-ItemProperty -Path $Key -Name DumpType -Value 1 -Type DWord
  Set-ItemProperty -Path $Key -Name DumpCount -Value 20 -Type DWord
}

$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\Gloom"
$StartMenuShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "Gloom.lnk"
$Install = Start-Process -FilePath $Installer -Wait -PassThru -ArgumentList @(
  "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/MERGETASKS=desktopicon", "/LOG=`"$(Join-Path $Evidence 'install.log')`""
)
if ($Install.ExitCode -ne 0) { throw "The installer failed: $($Install.ExitCode)" }
$Info = Get-Content -LiteralPath (Join-Path $InstallDir "Resources\version.json") -Raw | ConvertFrom-Json
Write-Line "installed $($Info.version) ($($Info.identifier), $($Info.channel)) in $InstallDir"

# As the update check leaves the installed build: its DevTools port open, and
# its updates asked of this machine (nothing listens, so a check fails fast).
$Info.hash = "repro-build"
$Info.baseUrl = "http://127.0.0.1:47821"
$Info | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $InstallDir "Resources\version.json") -Encoding UTF8
$BuildJsonPath = Join-Path $InstallDir "Resources\build.json"
$Build = Get-Content -LiteralPath $BuildJsonPath -Raw | ConvertFrom-Json
if ($Build.chromiumFlags) {
  $Build.chromiumFlags.PSObject.Properties.Remove("remote-debugging-port")
  $Build.chromiumFlags.PSObject.Properties.Remove("remote-allow-origins")
  if (@($Build.chromiumFlags.PSObject.Properties).Count -eq 0) { $Build.PSObject.Properties.Remove("chromiumFlags") }
  [IO.File]::WriteAllText($BuildJsonPath, ($Build | ConvertTo-Json -Depth 10 -Compress), (New-Object System.Text.UTF8Encoding $false))
}
if ($Prelude) {
  $MainJs = Join-Path $InstallDir "Resources\main.js"
  $Lines = [System.Collections.Generic.List[string]]([System.IO.File]::ReadAllLines($MainJs))
  $Lines.Insert($(if ($Lines[0] -like "// @bun*") { 1 } else { 0 }), $Prelude)
  [System.IO.File]::WriteAllLines($MainJs, $Lines, (New-Object System.Text.UTF8Encoding $false))
}

# The app's config, as the update check seeds it.
$ConfigHome = Join-Path $env:USERPROFILE ".gloomberb"
$DataDir = Join-Path $env:RUNNER_TEMP "gloom-repro-data"
$Layout = @{
  dockRoot = @{ kind = "pane"; instanceId = "portfolio-list:main" }
  instances = @(@{ instanceId = "portfolio-list:main"; paneId = "portfolio-list"; title = "Main Portfolio"; params = @{ collectionId = "main" }; binding = @{ kind = "none" } })
  floating = @()
  detached = @()
}
New-Item -ItemType Directory -Force -Path $ConfigHome, $DataDir | Out-Null
@{ dataDir = $DataDir } | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $ConfigHome "config.json") -Encoding UTF8
@{
  dataDir = $DataDir
  onboardingComplete = $true
  seededPlugins = @((& bun -e 'import { EXTRACTED_PLUGINS } from "./src/plugins/extracted-plugins"; console.log(JSON.stringify(EXTRACTED_PLUGINS.map(plugin => plugin.id)))') | ConvertFrom-Json)
  layout = $Layout
  layouts = @(@{ name = "Verification"; layout = $Layout; paneState = @{}; focusedPaneId = "portfolio-list:main" })
  activeLayoutIndex = 0
} | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $DataDir "config.json") -Encoding UTF8

$UpdaterApp = Join-Path $env:LOCALAPPDATA "$($Info.identifier)\$($Info.channel)\app"
$UpdaterUninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$($Info.identifier)"
$UpdaterShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Gloom updater copy.lnk"
$Pristine = Join-Path $env:RUNNER_TEMP "gloom-pristine"
Copy-Item -Recurse -LiteralPath $InstallDir -Destination $Pristine

# How every app process ends, with its full exit status.
$Stops = Join-Path $Evidence "process-stops.txt"
$StopWatcher = Start-Job -ArgumentList $Stops -ScriptBlock {
  param($Path)
  Register-CimIndicationEvent -ClassName Win32_ProcessStopTrace -SourceIdentifier stops
  while ($true) {
    $Event = Wait-Event -SourceIdentifier stops -Timeout 2
    if ($Event) {
      $Stop = $Event.SourceEventArgs.NewEvent
      if ($Stop.ProcessName -match "bun|launcher|powershell|schtasks") {
        Add-Content -LiteralPath $Path -Value ("{0:HH:mm:ss.fff} {1} pid {2} parent {3} exit 0x{4:X8}" -f (Get-Date), $Stop.ProcessName, $Stop.ProcessID, $Stop.ParentProcessID, $Stop.ExitStatus)
      }
      Remove-Event -EventIdentifier $Event.EventIdentifier
    }
  }
}
Start-Sleep -Seconds 3

$Crashed = @()
for ($Launch = 1; $Launch -le $Launches; $Launch += 1) {
  Stop-ProcessesUnder @($InstallDir, $UpdaterApp)
  if ($Copy) {
    Remove-Item -Recurse -Force -LiteralPath $UpdaterApp -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $UpdaterApp) | Out-Null
    Copy-Item -Recurse -LiteralPath $Pristine -Destination $UpdaterApp
    $Shell = New-Object -ComObject WScript.Shell
    $Link = $Shell.CreateShortcut($UpdaterShortcut)
    $Link.TargetPath = Join-Path $UpdaterApp "bin\launcher.exe"
    $Link.WorkingDirectory = Join-Path $UpdaterApp "bin"
    $Link.Save()
    New-Item -Path $UpdaterUninstallKey -Force | Out-Null
    New-ItemProperty -Path $UpdaterUninstallKey -Name "InstallLocation" -Value $UpdaterApp -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $UpdaterUninstallKey -Name "UninstallString" -Value "cmd.exe /c rmdir /s /q `"$UpdaterApp`"" -PropertyType String -Force | Out-Null
  }
  $StartedAt = Get-Date
  $Process = Start-Process -FilePath $StartMenuShortcut -PassThru
  $null = $Process.Handle
  $Bun = $null
  for ($Second = 1; $Second -le $Seconds; $Second += 1) {
    Start-Sleep -Seconds 1
    if (-not $Bun) { $Bun = Get-ProcessesUnder $InstallDir | Where-Object { $_.ProcessName -eq "bun" } | Select-Object -First 1; if ($Bun) { try { $null = $Bun.Handle } catch { } } }
    if ($Process.HasExited) { break }
  }
  $Removed = -not (Test-Path -LiteralPath $UpdaterApp)
  if ($Process.HasExited) {
    $BunCode = try { if ($Bun -and $Bun.HasExited) { "0x{0:X8}" -f $Bun.ExitCode } else { "unknown" } } catch { "unreadable: $($_.Exception.Message)" }
    $Line = "launch ${Launch}: launcher (pid $($Process.Id)) quit after $([math]::Round(($Process.ExitTime - $StartedAt).TotalSeconds, 1)) s with $($Process.ExitCode); bun.exe (pid $($Bun.Id)) with $BunCode; copy removed: $Removed"
    $Crashed += $Line
  } else {
    $Line = "launch ${Launch}: up after $Seconds s; copy removed: $Removed"
  }
  Write-Line $Line
}
Stop-ProcessesUnder @($InstallDir, $UpdaterApp)
Start-Sleep -Seconds 3
Stop-Job $StopWatcher -ErrorAction SilentlyContinue
Remove-Job $StopWatcher -Force -ErrorAction SilentlyContinue
Get-Content -LiteralPath $Stops -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch "exit 0x00000000|exit 0xFFFFFFFF|exit 0x00000001" } | ForEach-Object { Write-Line "stop: $_" }
Copy-Item -LiteralPath (Join-Path $DataDir "stall-log.txt") -Destination $Evidence -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $DataDir "crash-reports.json") -Destination $Evidence -ErrorAction SilentlyContinue

$Cdb = "C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe"
foreach ($Dump in (Get-ChildItem -LiteralPath $DumpDir -Filter *.dmp -ErrorAction SilentlyContinue)) {
  $Stacks = Join-Path $DumpDir "$($Dump.BaseName).stacks.txt"
  & $Cdb -z $Dump.FullName -y "srv*$env:RUNNER_TEMP\symbols*https://msdl.microsoft.com/download/symbols" -c ".lastevent; .exr -1; .ecxr; r; kn 60; lm; ~*kn 30; q" 2>&1 | Out-File $Stacks
  Write-Line "minidump $($Dump.Name), $($Dump.Length) bytes"
  Get-Content $Stacks | Select-String -Pattern "Last event|ExceptionCode|ExceptionAddress|Subcode|^[0-9a-f]{2} " | Select-Object -First 70 | ForEach-Object { Write-Line "  $_" }
}
Write-Line "$($Crashed.Count) of $Launches launches quit"

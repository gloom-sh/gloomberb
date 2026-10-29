$ErrorActionPreference = "Stop"

# The script the Windows app leaves to move an update into the installer's
# folder (src/renderers/electrobun/bun/desktop/installer-folder.ts), as the
# app writes it, run by Windows PowerShell 5.1 as the app runs it, on folders
# made here: which files it replaces, what it leaves, what a failure partway
# puts back, and when the app opens again. scripts/verify-windows-update.ps1
# runs it on a real install.

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
# A quote of each kind PowerShell reads in a path the script carries.
$Name = "gloom installer folder O'Brien" + [char]0x2019 + "s"
$Work = Join-Path $env:RUNNER_TEMP $Name
# The updater's folder is under %LOCALAPPDATA%, on C:; the checkout's temp is on D:.
$OtherDriveWork = Join-Path $env:LOCALAPPDATA $Name
$Failures = New-Object System.Collections.Generic.List[string]

if (-not $env:RUNNER_TEMP) {
  Write-Host "Skipping the installer folder script outside CI."
  exit 0
}

function Check {
  param([string]$Name, [bool]$Ok, [string]$Detail)
  if ($Ok) { Write-Host "ok   $Name" } else { Write-Host "FAIL $Name`n$Detail"; $Failures.Add($Name) }
}

# The script, as the app writes it for these folders.
function Write-MoveScript {
  param([string]$Path, [string]$Target, [string]$Source, [string]$Data, [bool]$AfterExit)

  $Writer = Join-Path $Work "write-script.ts"
  $Module = ($Root -replace '\\', '/') + "/src/renderers/electrobun/bun/desktop"
  [IO.File]::WriteAllText($Writer, @"
import { installerFolderScript } from "$Module/installer-folder";
import { writePowerShellScript } from "$Module/windows-script";
const args = JSON.parse(process.env.GLOOM_MOVE_SCRIPT ?? "{}");
await writePowerShellScript(args.path, installerFolderScript({
  target: args.target,
  sources: [args.source],
  folder: args.data,
  log: args.data + "\\installer-folder.log",
  afterExit: args.afterExit ? { cancel: args.data + "\\installer-folder.cancel", taskName: "" } : undefined,
}));
"@)
  $env:GLOOM_MOVE_SCRIPT = (@{ path = $Path; target = $Target; source = $Source; data = $Data; afterExit = $AfterExit } | ConvertTo-Json -Compress)
  & bun $Writer
  if ($LASTEXITCODE -ne 0) { throw "bun could not write the script" }
}

function Write-Tree {
  param([string]$Base, [hashtable]$Files)
  foreach ($Key in $Files.Keys) {
    $Path = Join-Path $Base $Key
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [IO.File]::WriteAllText($Path, $Files[$Key])
  }
}

# Every file and folder under $Base, with what the files hold.
function Get-Snapshot {
  param([string]$Base)
  if (-not (Test-Path -LiteralPath $Base)) { return "" }
  (Get-ChildItem -LiteralPath $Base -Recurse -Force | Sort-Object FullName | ForEach-Object {
    $Relative = $_.FullName.Substring($Base.Length + 1)
    if ($_.PSIsContainer) { "$Relative\" } else { "$Relative=" + [IO.File]::ReadAllText($_.FullName) }
  }) -join "`n"
}

function Get-Leftovers {
  param([string]$Target)
  @(Get-ChildItem -LiteralPath $Target -Force -Directory | Where-Object { $_.Name -like ".gloom-*" })
}

# An installed build and an update, both with a program that waits like the app does.
function New-Install {
  param([string]$Base)

  if (Test-Path -LiteralPath $Base) { Remove-Item -LiteralPath $Base -Recurse -Force }
  $Target = Join-Path $Base "Gloom"
  $Source = Join-Path $Base "data\app"
  Write-Tree $Target @{ "bin\a.dll" = "old a"; "bin\cef\x.pak" = "old x"; "Resources\version.json" = "old version"; "Info.plist" = "old plist"; "unins000.exe" = "uninstaller" }
  Write-Tree $Source @{ "bin\a.dll" = "new a"; "bin\b.dll" = "new b"; "bin\cef\x.pak" = "new x"; "Resources\version.json" = "new version"; "Info.plist" = "new plist" }
  foreach ($Folder in @($Target, $Source)) {
    Copy-Item -LiteralPath $Sleeper -Destination (Join-Path $Folder "bin\launcher.exe")
    Copy-Item -LiteralPath $Sleeper -Destination (Join-Path $Folder "bin\bun.exe")
  }
  @{ Target = $Target; Source = $Source; Data = (Join-Path $Base "data") }
}

function Get-RunningIn {
  param([string]$Folder)
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and $_.Path.StartsWith("$Folder\", [StringComparison]::OrdinalIgnoreCase) } catch { $false } })
}

function Stop-RunningIn {
  param([string]$Folder)
  Get-RunningIn $Folder | Stop-Process -Force -ErrorAction SilentlyContinue
  for ($Wait = 0; $Wait -lt 20 -and (Get-RunningIn $Folder).Count -gt 0; $Wait += 1) { Start-Sleep -Milliseconds 250 }
}

function Wait-For {
  param([int]$Seconds, [scriptblock]$Condition)
  $Deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $Deadline) {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds 250
  }
  [bool](& $Condition)
}

function Start-Program {
  param([string]$Path)
  Start-Process -FilePath $Path -WorkingDirectory (Split-Path -Parent $Path) | Out-Null
  Wait-For 10 { (Get-RunningIn (Split-Path -Parent $Path)).Count -gt 0 } | Out-Null
}

# The whole script, after the app's exit, the way the scheduled task runs it.
function Start-MoveScript {
  param($Install, [bool]$AfterExit = $true)
  $Path = Join-Path $Install.Data ("installer-folder-" + [guid]::NewGuid().ToString("N") + ".ps1")
  Write-MoveScript $Path $Install.Target $Install.Source $Install.Data $AfterExit
  Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -PassThru -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "`"$Path`"")
}

function Get-MoveLog {
  param($Install)
  try { [IO.File]::ReadAllText((Join-Path $Install.Data "installer-folder.log")) } catch { "" }
}

try {
  if ($PSVersionTable.PSVersion.Major -ne 5) { throw "Run this with Windows PowerShell 5.1, which the app runs the script with." }
  if (Test-Path -LiteralPath $Work) { Remove-Item -LiteralPath $Work -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Work | Out-Null
  $Sleeper = Join-Path $Work "sleeper.exe"
  Add-Type -OutputAssembly $Sleeper -OutputType WindowsApplication -TypeDefinition "public static class Sleeper { public static void Main() { System.Threading.Thread.Sleep(300000); } }"

  # Its functions, to run Install-Build on its own.
  $Functions = Join-Path $Work "functions.ps1"
  $Install = New-Install (Join-Path $Work "functions")
  Write-MoveScript $Functions $Install.Target $Install.Source $Install.Data $true
  $Text = [IO.File]::ReadAllText($Functions)
  $Main = $Text.IndexOf("# One script at a time")
  if ($Main -lt 0) { throw "The script has no '# One script at a time' section to stop before" }
  [IO.File]::WriteAllText($Functions, $Text.Substring(0, $Main), (New-Object Text.UTF8Encoding $true))
  . $Functions

  # 1. Folders holding nothing but the app's files are replaced whole; the
  #    uninstaller and the list of what updates put there stay right.
  $Install = New-Install (Join-Path $Work "whole")
  $Target = $Install.Target; $Log = Join-Path $Work "whole.log"
  $NewBin = Get-Snapshot (Join-Path $Install.Source "bin")
  Install-Build $Install.Source
  Check "whole: bin is the update's" ((Get-Snapshot (Join-Path $Target "bin")) -eq $NewBin) (Get-Snapshot $Target)
  Check "whole: the uninstaller stays" (Test-Path -LiteralPath (Join-Path $Target "unins000.exe")) ""
  Check "whole: the log says so" ([IO.File]::ReadAllText($Log).Contains("replaced $Target\bin")) ([IO.File]::ReadAllText($Log))
  Check "whole: nothing left beside it" ((Get-Leftovers $Target).Count -eq 0) ""
  $List = [IO.File]::ReadAllLines((Join-Path $Target "Resources\update-files.txt")) -join ","
  Check "whole: the files are listed for the uninstaller" ($List -eq "bin\a.dll,bin\b.dll,bin\bun.exe,bin\cef\x.pak,bin\launcher.exe,Info.plist,Resources\version.json") $List

  # 2. In a folder that also holds the user's files (C:\Tools, with its own
  #    bin), only the app's files are replaced.
  $Install = New-Install (Join-Path $Work "merge")
  $Target = $Install.Target; $Log = Join-Path $Work "merge.log"
  Write-Tree $Target @{ "bin\rg.exe" = "the user's"; "bin\scripts\notes.txt" = "the user's notes" }
  Install-Build $Install.Source
  Check "merge: the user's files stay" (([IO.File]::ReadAllText((Join-Path $Target "bin\rg.exe")) -eq "the user's") -and ([IO.File]::ReadAllText((Join-Path $Target "bin\scripts\notes.txt")) -eq "the user's notes")) (Get-Snapshot $Target)
  Check "merge: the app's files are replaced" (([IO.File]::ReadAllText((Join-Path $Target "bin\a.dll")) -eq "new a") -and ([IO.File]::ReadAllText((Join-Path $Target "bin\cef\x.pak")) -eq "new x") -and (Test-Path -LiteralPath (Join-Path $Target "bin\b.dll"))) (Get-Snapshot $Target)
  Check "merge: the log says so" ([IO.File]::ReadAllText($Log).Contains("kept 2 file(s) in $Target\bin that are not the app's")) ([IO.File]::ReadAllText($Log))
  Check "merge: nothing left beside it" ((Get-Leftovers $Target).Count -eq 0) ""
  $List = [IO.File]::ReadAllLines((Join-Path $Target "Resources\update-files.txt"))
  Check "merge: the user's files are not listed" (-not ($List -contains "bin\rg.exe")) ($List -join ",")

  # 3. A failure partway (here a folder of the user's where the build has a
  #    file) puts back every file it moved, in both folders.
  $Install = New-Install (Join-Path $Work "undo")
  $Target = $Install.Target; $Log = Join-Path $Work "undo.log"
  Write-Tree $Target @{ "bin\rg.exe" = "the user's"; "bin\b.dll\inside.txt" = "the user's" }
  $TargetBefore = Get-Snapshot $Target; $SourceBefore = Get-Snapshot $Install.Source
  $Failed = $null
  try { Install-Build $Install.Source } catch { $Failed = $_.Exception.Message }
  Check "undo: it fails" ($null -ne $Failed) ""
  Check "undo: the installed build is as it was" ((Get-Snapshot $Target) -eq $TargetBefore) (Get-Snapshot $Target)
  Check "undo: the update is as it was" ((Get-Snapshot $Install.Source) -eq $SourceBefore) (Get-Snapshot $Install.Source)

  # 4. From another drive, a copy that fails partway (a full disk, here a
  #    file it cannot read) changes nothing, and leaves no partial copy.
  if ((Split-Path -Qualifier $OtherDriveWork) -eq (Split-Path -Qualifier $Work)) {
    Write-Host "skip another drive: $OtherDriveWork is on the same drive as $Work"
  } else {
    $Install = New-Install (Join-Path $Work "other-drive")
    $Target = $Install.Target; $Log = Join-Path $Work "other-drive.log"
    if (Test-Path -LiteralPath $OtherDriveWork) { Remove-Item -LiteralPath $OtherDriveWork -Recurse -Force }
    Copy-Item -LiteralPath (Split-Path -Parent $Install.Source) -Destination $OtherDriveWork -Recurse
    $Source = Join-Path $OtherDriveWork "app"
    $TargetBefore = Get-Snapshot $Target
    $Lock = [IO.File]::Open((Join-Path $Source "bin\cef\x.pak"), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    $Failed = $null
    try { Install-Build $Source } catch { $Failed = $_.Exception.Message } finally { $Lock.Dispose() }
    Check "other drive: a failed copy fails the move" ($null -ne $Failed -and $Failed.StartsWith("could not copy the build into $Target")) $Failed
    Check "other drive: the installed build is as it was, with no partial copy" ((Get-Snapshot $Target) -eq $TargetBefore) (Get-Snapshot $Target)
    $SourceBefore = Get-Snapshot $Source
    Install-Build $Source
    Check "other drive: the next copy moves it in" ([IO.File]::ReadAllText((Join-Path $Target "bin\a.dll")) -eq "new a") (Get-Snapshot $Target)
    Check "other drive: nothing left beside it" ((Get-Leftovers $Target).Count -eq 0) (Get-Snapshot $Target)
    Check "other drive: the update stays for the script to remove" ((Get-Snapshot $Source) -eq $SourceBefore) ""
    Remove-Item -LiteralPath $OtherDriveWork -Recurse -Force
  }

  # 5. A move cut short leaves the installed build in what it set aside: it
  #    goes back before that is removed, and nothing a newer build dropped
  #    comes back beside it.
  $Install = New-Install (Join-Path $Work "restore")
  $Target = $Install.Target; $Log = Join-Path $Work "restore.log"
  $InstalledBin = Get-Snapshot (Join-Path $Target "bin")
  # A power cut between the two renames of bin.
  New-Item -ItemType Directory -Path (Join-Path $Target ".gloom-previous-20260101000000-a") | Out-Null
  Move-Item -LiteralPath (Join-Path $Target "bin") -Destination (Join-Path $Target ".gloom-previous-20260101000000-a\bin")
  Remove-Staging
  Check "restore: bin goes back whole" ((Get-Snapshot (Join-Path $Target "bin")) -eq $InstalledBin) (Get-Snapshot $Target)
  Check "restore: then what was set aside goes" ((Get-Leftovers $Target).Count -eq 0) (Get-Snapshot $Target)
  # One file at a time, cut short after the launcher was set aside.
  Write-Tree (Join-Path $Target ".gloom-previous-20260101000000-b") @{ "bin\a.dll" = "old a" }
  Move-Item -LiteralPath (Join-Path $Target "bin\launcher.exe") -Destination (Join-Path $Target ".gloom-previous-20260101000000-b\bin\launcher.exe")
  [IO.File]::WriteAllText((Join-Path $Target "bin\a.dll"), "new a")
  Remove-Staging
  Check "restore: the launcher goes back, beside what was already replaced" ((Test-Path -LiteralPath (Join-Path $Target "bin\launcher.exe")) -and [IO.File]::ReadAllText((Join-Path $Target "bin\a.dll")) -eq "new a") (Get-Snapshot $Target)
  Check "restore: then what was set aside goes too" ((Get-Leftovers $Target).Count -eq 0) (Get-Snapshot $Target)
  # A move that worked and could not remove what it replaced.
  Write-Tree (Join-Path $Target ".gloom-previous-20260101000000-c") @{ "bin\dropped.dll" = "old"; "bin\a.dll" = "old a" }
  Remove-Staging
  Check "restore: nothing comes back beside a whole build" (-not (Test-Path -LiteralPath (Join-Path $Target "bin\dropped.dll")) -and (Get-Leftovers $Target).Count -eq 0) (Get-Snapshot $Target)
  # With no launcher anywhere, what was set aside stays.
  Remove-Item -LiteralPath (Join-Path $Target "bin\launcher.exe")
  Write-Tree (Join-Path $Target ".gloom-previous-20260101000000-d") @{ "bin\a.dll" = "old a" }
  Remove-Staging
  Check "restore: what was set aside stays while the build has no launcher" ((Get-Leftovers $Target).Count -eq 1) (Get-Snapshot $Target)

  # 6. While a program of the app runs from the installer's folder (the
  #    gloom command), the script says so before the app would quit for it.
  $Install = New-Install (Join-Path $Work "busy")
  Start-Program (Join-Path $Install.Source "bin\launcher.exe")
  Start-Program (Join-Path $Install.Target "bin\bun.exe")
  $Script = Start-MoveScript $Install
  $Script.WaitForExit(60000) | Out-Null
  $MoveLog = Get-MoveLog $Install
  Check "busy: it says busy, and does not start" ($MoveLog.Contains(" busy: ") -and -not $MoveLog.Contains(" started ")) $MoveLog
  Check "busy: the installed build is as it was" ([IO.File]::ReadAllText((Join-Path $Install.Target "bin\a.dll")) -eq "old a") ""
  Stop-RunningIn $Install.Target
  Stop-RunningIn $Install.Source

  # 7. Once the app quits, the build moves in and the app opens from the
  #    installer's folder before the copy it came from goes.
  $Install = New-Install (Join-Path $Work "move")
  Start-Program (Join-Path $Install.Source "bin\launcher.exe")
  $Script = Start-MoveScript $Install
  Check "move: it starts" (Wait-For 30 { (Get-MoveLog $Install).Contains(" started ") }) (Get-MoveLog $Install)
  Stop-RunningIn $Install.Source
  $Script.WaitForExit(120000) | Out-Null
  $MoveLog = Get-MoveLog $Install
  $Opened = $MoveLog.IndexOf("opened $($Install.Target)\bin\launcher.exe")
  $Removed = $MoveLog.IndexOf("removed $($Install.Source)")
  Check "move: it opens the app from the installer's folder, then removes the copy" ($Opened -ge 0 -and $Removed -gt $Opened -and $MoveLog.Contains(" done")) $MoveLog
  Check "move: the app runs from the installer's folder" ((Wait-For 10 { (Get-RunningIn $Install.Target).Count -gt 0 }) -and -not (Test-Path -LiteralPath $Install.Source)) ""
  Stop-RunningIn $Install.Target

  # 8. An app slow to quit (past a minute) still ends up open, moved.
  $Install = New-Install (Join-Path $Work "slow")
  Start-Program (Join-Path $Install.Source "bin\launcher.exe")
  $Script = Start-MoveScript $Install
  Check "slow: it starts" (Wait-For 30 { (Get-MoveLog $Install).Contains(" started ") }) (Get-MoveLog $Install)
  Start-Sleep -Seconds 75
  Stop-RunningIn $Install.Source
  $Script.WaitForExit(120000) | Out-Null
  $MoveLog = Get-MoveLog $Install
  Check "slow: it waits, moves the build and opens the app" ($MoveLog.Contains(" moved ") -and $MoveLog.Contains("opened $($Install.Target)\bin\launcher.exe")) $MoveLog
  Check "slow: the app runs from the installer's folder" (Wait-For 10 { (Get-RunningIn $Install.Target).Count -gt 0 }) ""
  Stop-RunningIn $Install.Target

  # 9. A move that fails after the app quit opens it again where it was.
  $Install = New-Install (Join-Path $Work "reopen")
  Write-Tree $Install.Target @{ "bin\b.dll\inside.txt" = "the user's" }
  $TargetBefore = Get-Snapshot $Install.Target
  Start-Program (Join-Path $Install.Source "bin\launcher.exe")
  $Script = Start-MoveScript $Install
  Check "reopen: it starts" (Wait-For 30 { (Get-MoveLog $Install).Contains(" started ") }) (Get-MoveLog $Install)
  Stop-RunningIn $Install.Source
  $Script.WaitForExit(120000) | Out-Null
  $MoveLog = Get-MoveLog $Install
  Check "reopen: it fails and opens the app where it was" ($MoveLog.Contains(" move failed: ") -and $MoveLog.Contains("opened $($Install.Source)\bin\launcher.exe") -and -not $MoveLog.Contains("opened $($Install.Target)")) $MoveLog
  Check "reopen: the app runs where it was" (Wait-For 10 { (Get-RunningIn $Install.Source).Count -gt 0 }) ""
  Check "reopen: the installed build is as it was" ((Get-Snapshot $Install.Target) -eq $TargetBefore) (Get-Snapshot $Install.Target)
  Stop-RunningIn $Install.Source

  # 10. When the app stopped waiting for the script, the script leaves it be,
  #    and never opens a second one.
  $Install = New-Install (Join-Path $Work "cancel")
  Start-Program (Join-Path $Install.Source "bin\launcher.exe")
  $Script = Start-MoveScript $Install
  Check "cancel: it starts" (Wait-For 30 { (Get-MoveLog $Install).Contains(" started ") }) (Get-MoveLog $Install)
  [IO.File]::WriteAllText((Join-Path $Install.Data "installer-folder.cancel"), "")
  Stop-RunningIn $Install.Source
  $Script.WaitForExit(60000) | Out-Null
  $MoveLog = Get-MoveLog $Install
  Check "cancel: nothing moves, nothing opens" ($MoveLog.Contains("stopped waiting") -and -not $MoveLog.Contains("opened") -and -not $MoveLog.Contains(" moved ")) $MoveLog
  Check "cancel: no app runs" (((Get-RunningIn $Install.Source).Count -eq 0) -and ((Get-RunningIn $Install.Target).Count -eq 0)) ""
} finally {
  foreach ($Folder in @($Work, $OtherDriveWork)) {
    Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and $_.Path.StartsWith("$Folder\", [StringComparison]::OrdinalIgnoreCase) } catch { $false } } | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  Remove-Item -LiteralPath $Work, $OtherDriveWork -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item Env:GLOOM_MOVE_SCRIPT -ErrorAction SilentlyContinue
}

if ($Failures.Count -gt 0) { throw "$($Failures.Count) check(s) failed: $($Failures -join '; ')" }
Write-Host "The installer folder script replaces only the app's files, puts back what a failed move took, and opens the app once, where it belongs."

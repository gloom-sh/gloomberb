param(
  # This build's installer: its PrepareToInstall runs over an earlier install whose uninstaller fails.
  [string]$Installer = ""
)

$ErrorActionPreference = "Stop"
$env:GLOOMBERB_NO_TELEMETRY = "1"
$env:DO_NOT_TRACK = "1"

# The script the Windows app leaves to retire an earlier installer's folder
# (src/renderers/electrobun/bun/desktop/installer-folder.ts), as the app
# writes it, run by Windows PowerShell 5.1 as the app runs it, over installs
# made up here: an uninstaller that fails, an earlier build still running, a
# folder the user picked with a file of theirs in it, and the installer's
# default folder. With -Installer, this build's installer over an earlier
# install whose uninstaller fails. scripts/verify-windows-update.ps1 retires
# a real install.
#
# It works on the runner's own uninstall entry, Start menu, Desktop and user
# PATH, as the script does, and puts them back as they were.

if (-not $env:RUNNER_TEMP) {
  Write-Host "Skipping the installer folder checks outside CI: they change the user's uninstall entries, shortcuts and PATH."
  exit 0
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
# A quote of each kind PowerShell reads in a path the script carries.
$Work = Join-Path $env:LOCALAPPDATA ("gloom installer folder O'Brien" + [char]0x2019 + "s")
$EntryKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{D7B2304C-840B-4E5F-956A-3D1C66E67B35}_is1"
$DefaultFolder = Join-Path $env:LOCALAPPDATA "Programs\Gloom"
$ElectrobunRoot = Join-Path $env:LOCALAPPDATA "com.vincelwt.gloomberb"
$StartMenuShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "Gloom.lnk"
$DesktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Gloom.lnk"
$App = Join-Path $Work "app"
$Failures = New-Object System.Collections.Generic.List[string]

function Check {
  param([string]$Name, [bool]$Ok, [string]$Detail)
  if ($Ok) { Write-Host "ok   $Name" } else { Write-Host "FAIL $Name`n$Detail"; $Failures.Add($Name) }
}

function Get-RawUserPath {
  $Key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment")
  try {
    if (-not $Key -or $null -eq $Key.GetValue("Path")) { return $null }
    @{ Value = [string]$Key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); Kind = $Key.GetValueKind("Path") }
  } finally { if ($Key) { $Key.Close() } }
}

function Set-RawUserPath($Path) {
  $Key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
  try {
    if ($null -eq $Path) { $Key.DeleteValue("Path", $false) } else { $Key.SetValue("Path", $Path.Value, $Path.Kind) }
  } finally { $Key.Close() }
}

function Get-PathEntries {
  $Path = Get-RawUserPath
  if ($null -eq $Path) { return @() }
  @($Path.Value -split ";" | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim().TrimEnd("\").ToLowerInvariant() })
}

function Get-ShortcutTarget([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return "" }
  (New-Object -ComObject WScript.Shell).CreateShortcut($Path).TargetPath
}

function New-Shortcut([string]$Path, [string]$Target) {
  $Link = (New-Object -ComObject WScript.Shell).CreateShortcut($Path)
  $Link.TargetPath = $Target
  $Link.Save()
}

function Write-Tree {
  param([string]$Base, [hashtable]$Files)
  foreach ($Key in $Files.Keys) {
    $Path = Join-Path $Base $Key
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    [IO.File]::WriteAllText($Path, $Files[$Key])
  }
}

# An earlier installer's install in $Folder: its files, its uninstaller (which
# fails with "fail" in uninstaller-mode.txt, and otherwise removes what it
# installed, its Start menu shortcut and its entry, as Inno's does), its
# entry, its PATH entry and its shortcut.
function New-EarlierInstall {
  param([string]$Folder, [string]$Mode, [hashtable]$UserFiles = @{})
  if (Test-Path -LiteralPath $Folder) { Remove-Item -LiteralPath $Folder -Recurse -Force }
  Write-Tree $Folder @{ "Resources\version.json" = "earlier"; "uninstaller-mode.txt" = $Mode; "uninstaller-files.txt" = "Resources\version.json`r`nbin\launcher.exe`r`nbin\bun.exe" }
  Write-Tree $Folder $UserFiles
  New-Item -ItemType Directory -Force -Path (Join-Path $Folder "bin") | Out-Null
  Copy-Item -LiteralPath $Sleeper -Destination (Join-Path $Folder "bin\launcher.exe")
  Copy-Item -LiteralPath $Sleeper -Destination (Join-Path $Folder "bin\bun.exe")
  Copy-Item -LiteralPath $FakeUninstaller -Destination (Join-Path $Folder "unins000.exe")
  New-Item -Path $EntryKey -Force | Out-Null
  Set-ItemProperty -LiteralPath $EntryKey -Name "Inno Setup: App Path" -Value $Folder
  Set-ItemProperty -LiteralPath $EntryKey -Name "UninstallString" -Value ('"' + (Join-Path $Folder "unins000.exe") + '"')
  $Path = Get-RawUserPath
  $Kind = if ($null -eq $Path) { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { $Path.Kind }
  $Value = if ($null -eq $Path -or -not $Path.Value) { "" } else { $Path.Value.TrimEnd(";") + ";" }
  Set-RawUserPath @{ Value = $Value + (Join-Path $Folder "bin"); Kind = $Kind }
  New-Shortcut $StartMenuShortcut (Join-Path $Folder "bin\launcher.exe")
}

function Remove-EarlierInstall([string]$Folder) {
  Get-RunningFrom $Folder | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  if (Test-Path -LiteralPath $EntryKey) { Remove-Item -LiteralPath $EntryKey -Recurse -Force }
  if (Test-Path -LiteralPath $Folder) { Remove-Item -LiteralPath $Folder -Recurse -Force }
  foreach ($Shortcut in @($StartMenuShortcut, $DesktopShortcut)) { if (Test-Path -LiteralPath $Shortcut) { Remove-Item -LiteralPath $Shortcut -Force } }
  Set-RawUserPath $SavedPath
}

function Get-RunningFrom([string]$Folder) {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object { try { $_.Path -and $_.Path.StartsWith("$Folder\", [StringComparison]::OrdinalIgnoreCase) } catch { $false } })
}

# The script as the app writes it for $Folder, run as the app runs it, to its end.
function Invoke-Retire {
  param([string]$Folder)
  $Data = Join-Path $Work "data"
  New-Item -ItemType Directory -Force -Path $Data | Out-Null
  $Script = Join-Path $Data ("installer-folder-retire-" + [guid]::NewGuid().ToString("N") + ".ps1")
  $Writer = Join-Path $Work "write-script.ts"
  $Module = ($Root -replace '\\', '/') + "/src/renderers/electrobun/bun/desktop"
  [IO.File]::WriteAllText($Writer, @"
import { installerFolderScript } from "$Module/installer-folder";
import { writePowerShellScript } from "$Module/windows-script";
const args = JSON.parse(process.env.GLOOM_RETIRE_SCRIPT ?? "{}");
await writePowerShellScript(args.script, installerFolderScript({ folder: args.folder, app: args.app, log: args.log, pending: args.pending }));
"@)
  $env:GLOOM_RETIRE_SCRIPT = (@{ script = $Script; folder = $Folder; app = $App; log = $Log; pending = $Pending } | ConvertTo-Json -Compress)
  & bun $Writer | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "bun could not write the script" }
  [IO.File]::WriteAllText($Pending, $Folder)
  $Process = Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -PassThru -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", "`"$Script`"")
  # Its exit code reads back only with the handle taken while it runs.
  $null = $Process.Handle
  if (-not $Process.WaitForExit(300000)) { throw "the script ran past five minutes" }
  $Process.ExitCode
}

function Get-RetireLog {
  try { [IO.File]::ReadAllText($Log) } catch { "" }
}

$Launcher = Join-Path $App "bin\launcher.exe"
$Log = Join-Path $Work "data\installer-folder.log"
$Pending = Join-Path $Work "data\installer-folder.pending"
$SavedPath = Get-RawUserPath

try {
  if ($PSVersionTable.PSVersion.Major -ne 5) { throw "Run this with Windows PowerShell 5.1, which the app runs the script with." }
  foreach ($Taken in @($EntryKey, $DefaultFolder, $StartMenuShortcut, $DesktopShortcut, $ElectrobunRoot)) {
    if (Test-Path -LiteralPath $Taken) { throw "$Taken is already there: run this on a runner without Gloom." }
  }
  if (Test-Path -LiteralPath $Work) { Remove-Item -LiteralPath $Work -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Work | Out-Null
  $Sleeper = Join-Path $Work "sleeper.exe"
  Add-Type -OutputAssembly $Sleeper -OutputType WindowsApplication -TypeDefinition "public static class Sleeper { public static void Main() { System.Threading.Thread.Sleep(300000); } }"
  $FakeUninstaller = Join-Path $Work "fake-uninstaller.exe"
  Add-Type -OutputAssembly $FakeUninstaller -OutputType WindowsApplication -TypeDefinition @"
using System;
using System.IO;
public static class FakeUninstaller {
  public static int Main(string[] args) {
    string dir = AppDomain.CurrentDomain.BaseDirectory;
    File.AppendAllText(Path.Combine(dir, "uninstaller-ran.txt"), string.Join(" ", args) + Environment.NewLine);
    if (File.ReadAllText(Path.Combine(dir, "uninstaller-mode.txt")).Trim() == "fail") return 5;
    foreach (string relative in File.ReadAllLines(Path.Combine(dir, "uninstaller-files.txt"))) {
      string file = Path.Combine(dir, relative);
      if (File.Exists(file)) File.Delete(file);
    }
    string link = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Gloom.lnk");
    if (File.Exists(link)) File.Delete(link);
    Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\{D7B2304C-840B-4E5F-956A-3D1C66E67B35}_is1", false);
    return 0;
  }
}
"@
  New-Item -ItemType Directory -Force -Path (Join-Path $App "bin") | Out-Null
  Copy-Item -LiteralPath $Sleeper -Destination $Launcher
  $AppBin = (Join-Path $App "bin").TrimEnd("\").ToLowerInvariant()

  # 1. An uninstaller that fails keeps its entry and its folder for the next
  #    start. The shortcuts and PATH lead to this build meanwhile.
  $Folder = Join-Path $Work "Tools"
  New-EarlierInstall $Folder "fail" @{ "notes.txt" = "the user's" }
  New-Shortcut $DesktopShortcut (Join-Path $Folder "bin\launcher.exe")
  $Code = Invoke-Retire $Folder
  $RetireLog = Get-RetireLog
  Check "failing uninstaller: the script says it is unfinished" ($Code -eq 2 -and $RetireLog.Contains("did not finish; its entry stays")) "exit $Code`n$RetireLog"
  Check "failing uninstaller: its entry stays" (Test-Path -LiteralPath $EntryKey) ""
  Check "failing uninstaller: its folder and uninstaller stay" ((Test-Path -LiteralPath (Join-Path $Folder "unins000.exe")) -and (Test-Path -LiteralPath (Join-Path $Folder "bin\bun.exe"))) ""
  Check "failing uninstaller: the next start is due" (Test-Path -LiteralPath $Pending) ""
  Check "failing uninstaller: the shortcuts lead to this build" (((Get-ShortcutTarget $StartMenuShortcut) -eq $Launcher) -and ((Get-ShortcutTarget $DesktopShortcut) -eq $Launcher)) "$(Get-ShortcutTarget $StartMenuShortcut) / $(Get-ShortcutTarget $DesktopShortcut)"
  $Entries = Get-PathEntries
  Check "failing uninstaller: PATH leads to this build" (($Entries -contains $AppBin) -and -not ($Entries -contains (Join-Path $Folder "bin").ToLowerInvariant())) ($Entries -join ";")

  # 2. The next start, once the uninstaller works: the user's file stays in
  #    the folder they picked; the rest is done.
  [IO.File]::WriteAllText((Join-Path $Folder "uninstaller-mode.txt"), "ok")
  Remove-Item -LiteralPath $Log -Force
  $Code = Invoke-Retire $Folder
  $RetireLog = Get-RetireLog
  Check "retry: it finishes" ($Code -eq 0 -and $RetireLog.Contains(" done") -and -not (Test-Path -LiteralPath $Pending)) "exit $Code`n$RetireLog"
  Check "retry: the entry is gone" (-not (Test-Path -LiteralPath $EntryKey)) ""
  Check "retry: the user's file stays in the folder they picked" (([IO.File]::ReadAllText((Join-Path $Folder "notes.txt")) -eq "the user's") -and -not (Test-Path -LiteralPath (Join-Path $Folder "bin\bun.exe"))) (@(Get-ChildItem -LiteralPath $Folder -Recurse -Force | ForEach-Object { $_.FullName }) -join "`n")
  Check "retry: the shortcut the uninstaller removed leads to this build again" (((Get-ShortcutTarget $StartMenuShortcut) -eq $Launcher) -and ((Get-ShortcutTarget $DesktopShortcut) -eq $Launcher)) "$(Get-ShortcutTarget $StartMenuShortcut) / $(Get-ShortcutTarget $DesktopShortcut)"
  Remove-EarlierInstall $Folder
  Remove-Item -LiteralPath $Log -Force

  # 3. While the earlier build runs from its folder, nothing is uninstalled.
  $Folder = Join-Path $Work "Running"
  New-EarlierInstall $Folder "ok"
  Start-Process -FilePath (Join-Path $Folder "bin\bun.exe") | Out-Null
  $Code = Invoke-Retire $Folder
  $RetireLog = Get-RetireLog
  Check "running: it waits for the next start" ($Code -eq 2 -and $RetireLog.Contains("still runs from")) "exit $Code`n$RetireLog"
  Check "running: the uninstaller did not run, and the entry stays" ((-not (Test-Path -LiteralPath (Join-Path $Folder "uninstaller-ran.txt"))) -and (Test-Path -LiteralPath $EntryKey)) ""
  Check "running: the Start menu leads to this build" ((Get-ShortcutTarget $StartMenuShortcut) -eq $Launcher) (Get-ShortcutTarget $StartMenuShortcut)
  Remove-EarlierInstall $Folder
  Remove-Item -LiteralPath $Log -Force

  # 4. The installer's default folder goes whole, with what the app wrote there.
  New-EarlierInstall $DefaultFolder "ok" @{ "bin\app.log" = "written by the app" }
  $Code = Invoke-Retire $DefaultFolder
  $RetireLog = Get-RetireLog
  Check "default folder: it finishes" ($Code -eq 0 -and $RetireLog.Contains(" done")) "exit $Code`n$RetireLog"
  Check "default folder: it is gone" (-not (Test-Path -LiteralPath $DefaultFolder)) $RetireLog
  Check "default folder: the entry is gone" (-not (Test-Path -LiteralPath $EntryKey)) ""
  $Entries = Get-PathEntries
  Check "default folder: PATH leads to this build" (($Entries -contains $AppBin) -and -not ($Entries -contains (Join-Path $DefaultFolder "bin").ToLowerInvariant())) ($Entries -join ";")
  Remove-EarlierInstall $DefaultFolder

  # 5. This build's installer over an install whose uninstaller fails keeps
  #    its entry and its folder for the app to try again, and installs.
  if ($Installer) {
    New-EarlierInstall $DefaultFolder "fail"
    $SetupLog = Join-Path $Work "setup.log"
    $Setup = Start-Process -FilePath (Resolve-Path $Installer).Path -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=`"$SetupLog`"") -PassThru -Wait
    $SetupText = try { [IO.File]::ReadAllText($SetupLog) } catch { "" }
    Check "installer: it installs" ($Setup.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $ElectrobunRoot "stable\app\bin\launcher.exe"))) "exit $($Setup.ExitCode)"
    Check "installer: the earlier entry stays for the app" ((Test-Path -LiteralPath $EntryKey) -and $SetupText.Contains("its record stays for the app to try again")) $SetupText
    Check "installer: the earlier folder stays, with its uninstaller" (Test-Path -LiteralPath (Join-Path $DefaultFolder "unins000.exe")) ""
    $Entries = Get-PathEntries
    Check "installer: PATH leads to the new install" (($Entries -contains (Join-Path $ElectrobunRoot "stable\app\bin").ToLowerInvariant()) -and -not ($Entries -contains (Join-Path $DefaultFolder "bin").ToLowerInvariant())) ($Entries -join ";")
    Remove-EarlierInstall $DefaultFolder
  }
} finally {
  foreach ($Folder in @($Work, $DefaultFolder, $ElectrobunRoot)) {
    Get-RunningFrom $Folder | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  if (Test-Path -LiteralPath $EntryKey) { Remove-Item -LiteralPath $EntryKey -Recurse -Force -ErrorAction SilentlyContinue }
  foreach ($Shortcut in @($StartMenuShortcut, $DesktopShortcut)) { Remove-Item -LiteralPath $Shortcut -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $Work, $DefaultFolder, $ElectrobunRoot -Recurse -Force -ErrorAction SilentlyContinue
  Set-RawUserPath $SavedPath
  Remove-Item Env:GLOOM_RETIRE_SCRIPT -ErrorAction SilentlyContinue
}

if ($Failures.Count -gt 0) { throw "$($Failures.Count) check(s) failed: $($Failures -join '; ')" }
Write-Host "The installer's folder is retired only once its uninstaller worked, the shortcuts and PATH lead to this build either way, and a failure is tried again."

import { lstat, mkdir, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { win32 } from "path";
import { logFailure } from "../../../../utils/log-failure";
import { DESKTOP_APP_IDENTIFIER, DESKTOP_APP_IDENTIFIERS } from "../../shared/app-name";
import { psString, runScriptAfterExit, runScriptInBackground, writePowerShellScript } from "./windows-script";

/**
 * The Windows installer (scripts/windows-installer.iss) puts the app in its
 * own folder, `Programs\Gloom` unless the user picks another, and its Start
 * menu and Desktop shortcuts, the `gloom` command on PATH and its uninstall
 * entry lead there. Electrobun's updater knows nothing of it: it installs
 * every update into its own folder, `<app data>\<identifier>\<channel>\app`,
 * and opens it from there. The next start from a shortcut opened the build
 * from before the update, which offered the same update again, and
 * uninstalling left the updated copy behind.
 *
 * So a build that finds itself in the updater's folder while the installer's
 * install is recorded quits before any window shows, and a script moves it
 * into the installer's folder and opens it from there. A build running from
 * the installer's folder removes a copy an earlier update left in the
 * updater's. Either way the shortcuts and uninstall entry Electrobun's own
 * setup made for its folder, if any, follow to the installer's.
 *
 * The app quits for the move only once the script has checked it can make
 * it, and tries a build at most three times, ten minutes apart: a move that
 * cannot happen never makes it quit and open again at every start.
 */

/** The installer's AppId, which names its uninstall entry (windows-installer.iss). */
export const WINDOWS_INSTALLER_APP_ID = "{D7B2304C-840B-4E5F-956A-3D1C66E67B35}";
const INSTALLER_ENTRY = `${WINDOWS_INSTALLER_APP_ID}_is1`;

export interface InstallerFolderContext {
  platform: string;
  execPath: string;
  homeDir: string;
  /** `%LOCALAPPDATA%`, where Electrobun keeps the updater's folder. */
  localAppData?: string;
  /** The folder the installer's uninstall entry records, or null; read from the registry when left out. */
  readInstallerFolder?: () => Promise<string | null>;
}

export type InstallerFolderMove =
  /** Not an installer install, or already in its folder with nothing left elsewhere. */
  | { kind: "none" }
  /** The app runs from the updater's folder, and quits for the script to move it and open it again. */
  | { kind: "relaunching" }
  /** A copy left in the updater's folder goes in the background. */
  | { kind: "removing" }
  /** The app runs from where it is: a try failed a moment ago, tries failed too often for this build, or the installer's folder is in use. */
  | { kind: "skipped" }
  | { kind: "failed" };

/** How long a try at moving the app keeps it from trying again, so a move that cannot happen never makes it quit in a loop. */
const RETRY_AFTER_MS = 10 * 60_000;
/** Tries at moving one build before it stays in the updater's folder until the next update. */
const MAX_MOVE_TRIES = 3;
/** How long after the start a copy left in the updater's folder goes, out of the launch's way. */
const REMOVAL_DELAY_MS = 10_000;
const LAUNCHER = "bin\\launcher.exe";

function samePath(left: string, right: string): boolean {
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

function isDesktopIdentifierName(name: string): boolean {
  return DESKTOP_APP_IDENTIFIERS.some((identifier) => identifier.toLowerCase() === name.toLowerCase());
}

/**
 * The updater's folder the app runs from, from its `bin\bun.exe`:
 * `<local app data>\<identifier>\<channel>\app`, under either identifier the
 * app has carried. Null anywhere else.
 */
export function updaterAppFolder(execPath: string, localAppData: string): { folder: string; channel: string } | null {
  const relative = win32.relative(localAppData, execPath);
  if (!relative || relative.startsWith("..") || win32.isAbsolute(relative)) return null;
  const [identifier, channel, app, bin, ...rest] = relative.split("\\");
  if (!identifier || !channel || rest.length !== 1 || !isDesktopIdentifierName(identifier)) return null;
  if (app?.toLowerCase() !== "app" || bin?.toLowerCase() !== "bin") return null;
  return { folder: win32.join(localAppData, identifier, channel, "app"), channel };
}

/**
 * The updater's folders for `channel` under either identifier, and what a
 * removal that did not finish left of one (`app.removing-*`).
 */
async function updaterFolders(localAppData: string, channel: string): Promise<string[]> {
  const folders: string[] = [];
  for (const identifier of DESKTOP_APP_IDENTIFIERS) {
    const parent = win32.join(localAppData, identifier, channel);
    for (const entry of await readdir(parent).catch(() => [] as string[])) {
      const name = entry.toLowerCase();
      if (name === "app" || name.startsWith("app.removing-")) folders.push(win32.join(parent, entry));
    }
  }
  return folders;
}

/** The value `name` holds in a `.reg` export, unescaped; null when it holds none or no string. */
export function regExportValue(text: string, name: string): string | null {
  const prefix = `${JSON.stringify(name)}=`;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    const value = line.slice(prefix.length);
    if (value.length < 2 || !value.startsWith("\"") || !value.endsWith("\"")) return null;
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return null;
}

/**
 * The folder the installer's uninstall entry records. `reg export` writes
 * UTF-16, where `reg query` would print a path with an accent in the console's
 * code page.
 */
async function readInstallerFolderFromRegistry(): Promise<string | null> {
  const file = win32.join(tmpdir(), `gloom-installer-entry-${process.pid}.reg`);
  try {
    const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${INSTALLER_ENTRY}`;
    const result = Bun.spawnSync(["reg.exe", "export", key, file, "/y"], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    if (!result.success) return null;
    return regExportValue(new TextDecoder("utf-16le").decode(await readFile(file)), "Inno Setup: App Path");
  } finally {
    await rm(file, { force: true });
  }
}

/** The installer's folder, when it holds the app. */
async function installerFolder(read: () => Promise<string | null>): Promise<string | null> {
  const folder = await read().catch(() => null);
  if (!folder) return null;
  return (await exists(win32.join(folder, LAUNCHER))) ? win32.resolve(folder) : null;
}

async function buildChannel(appFolder: string): Promise<string> {
  const info = await readFile(win32.join(appFolder, "Resources", "version.json"), "utf8").then((text) => JSON.parse(text) as { channel?: unknown }, () => null);
  return typeof info?.channel === "string" && info.channel ? info.channel : "stable";
}

interface InstallerFolderScript {
  /** The installer's folder. */
  target: string;
  /** The updater's folders to empty into it or remove; with `afterExit`, the first holds the running app. */
  sources: string[];
  /** This build's app data folder: the script's log goes there, and a folder it removes is moved there first. */
  folder: string;
  log: string;
  /**
   * The app runs from `sources[0]`: the script waits for everything running
   * from there to quit, moves it into `target` and opens it again. `cancel`
   * is the file the app writes when it stops waiting for the script.
   */
  afterExit?: { cancel: string; taskName: string };
}

// PowerShell 5.1. The build goes into the installer's folder by renames only:
// from another drive it is copied beside the installed build first. A folder
// of the build (bin, Resources) replaces the installed one whole when that
// holds nothing but the app's files; in one that also holds other files (an
// install in C:\Tools, whose bin was already there) only the app's files are
// replaced. What it replaces waits beside it, in the installer's folder,
// until all of the build is in, and goes back if it is not. Then the app
// opens again, and the rest (shortcuts, uninstall entries, the copy it came
// from) follows.
const SCRIPT_BODY = String.raw`
$Launcher = 'bin\launcher.exe'
$FileList = 'Resources\update-files.txt'
$UninstallPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'
$Journal = New-Object System.Collections.Generic.List[object]
$Exited = $false
$Opened = $false

function Write-Log([string]$Message) {
  for ($Attempt = 0; $Attempt -lt 10; $Attempt += 1) {
    try { Add-Content -LiteralPath $Log -Value ((Get-Date).ToString('o') + ' ' + $Message); return } catch { Start-Sleep -Milliseconds 100 }
  }
}

function Test-Under([string]$Path, [string]$Root) {
  if (-not $Path) { return $false }
  return $Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)
}

# The processes whose program is in $Root, whatever started them.
function Get-RunningUnder([string]$Root) {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object { try { Test-Under $_.Path $Root } catch { $false } })
}

# The processes running one of the build's programs from the installer's
# folder, such as the gloom command: they keep its files from being replaced.
# Another program the user keeps in that folder does not.
function Get-AppRunningInTarget {
  @(Get-RunningUnder $Target | Where-Object { $BuildFiles.Contains($_.Path.Substring($Target.Length + 1)) })
}

function Wait-Until([int]$Seconds, [scriptblock]$Condition) {
  for ($Wait = 0; $Wait -lt ($Seconds * 2); $Wait += 1) {
    if (& $Condition) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return [bool](& $Condition)
}

function Invoke-Retried([scriptblock]$Action, [string]$What) {
  for ($Attempt = 1; $true; $Attempt += 1) {
    try { & $Action | Out-Null; return } catch {
      if ($Attempt -ge 20) { throw ('could not ' + $What + ': ' + $_.Exception.Message) }
      Start-Sleep -Milliseconds 500
    }
  }
}

function Get-Stamp { (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8) }

function Test-Folder([string]$Path) {
  $Item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  return ($null -ne $Item) -and $Item.PSIsContainer -and -not ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

# The files in $Root, as paths after $Prefix. A link is a file here: it is not followed.
function Get-Files([string]$Root, [string]$Prefix) {
  foreach ($Item in @(Get-ChildItem -LiteralPath $Root -Force)) {
    $Relative = if ($Prefix) { $Prefix + '\' + $Item.Name } else { $Item.Name }
    if ($Item.PSIsContainer -and -not ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Get-Files $Item.FullName $Relative } else { $Relative }
  }
}

function Remove-Tree([string]$Path) {
  if (Test-Path -LiteralPath $Path) { Invoke-Retried { Remove-Item -LiteralPath $Path -Recurse -Force } ('remove ' + $Path) }
}

# Makes the missing folders up to $Path, each noted to take back.
function New-Folder([string]$Path) {
  if (Test-Path -LiteralPath $Path) { return }
  New-Folder (Split-Path -Parent $Path)
  New-Item -ItemType Directory -Path $Path | Out-Null
  $Journal.Add(@($null, $Path))
}

# A rename, noted to take back. Nothing lands inside a folder in its way.
function Move-Noted([string]$From, [string]$To) {
  if (Test-Path -LiteralPath $To) { throw ($To + ' is in the way') }
  New-Folder (Split-Path -Parent $To)
  Invoke-Retried { Move-Item -LiteralPath $From -Destination $To } ('move ' + $From)
  $Journal.Add(@($From, $To))
}

function Undo-Noted {
  for ($Index = $Journal.Count - 1; $Index -ge 0; $Index -= 1) {
    $Step = $Journal[$Index]
    try {
      if ($null -eq $Step[0]) {
        [IO.Directory]::Delete($Step[1], $false)
      } else {
        if (Test-Path -LiteralPath $Step[0]) { throw ($Step[0] + ' is in the way') }
        Invoke-Retried { Move-Item -LiteralPath $Step[1] -Destination $Step[0] } ('put back ' + $Step[0])
      }
    } catch { Write-Log ('could not take back a step: ' + $_.Exception.Message) }
  }
  $Journal.Clear()
}

# The files earlier updates put in the installer's folder, as they listed them.
function Read-FileList {
  $Path = Join-Path $Target $FileList
  if (-not (Test-Path -LiteralPath $Path)) { return }
  foreach ($Line in [IO.File]::ReadAllLines($Path)) {
    $Line = $Line.Trim()
    if ($Line -and $Line -notmatch '^[\\/]|:|\.\.') { $Line }
  }
}

function Install-Build([string]$Source) {
  $Stamp = Get-Stamp
  $From = $Source
  $Next = $null
  if (-not [IO.Path]::GetPathRoot($Source).Equals([IO.Path]::GetPathRoot($Target), [StringComparison]::OrdinalIgnoreCase)) {
    $Next = Join-Path $Target ('.gloom-next-' + $Stamp)
    try {
      New-Item -ItemType Directory -Path $Next | Out-Null
      foreach ($Entry in @(Get-ChildItem -LiteralPath $Source -Force)) {
        Copy-Item -LiteralPath $Entry.FullName -Destination (Join-Path $Next $Entry.Name) -Recurse -Force
      }
    } catch {
      $Reason = $_.Exception.Message
      try { Remove-Tree $Next } catch { Write-Log ('could not remove ' + $Next + ': ' + $_.Exception.Message) }
      throw ('could not copy the build into ' + $Target + ': ' + $Reason)
    }
    $From = $Next
  }

  $NewFiles = @(Get-Files $From '')
  $Listed = @(Read-FileList)
  $Own = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($File in ($NewFiles + $Listed + @($FileList))) { [void]$Own.Add($File) }
  $Aside = Join-Path $Target ('.gloom-previous-' + $Stamp)
  $Journal.Clear()
  try {
    foreach ($Entry in @(Get-ChildItem -LiteralPath $From -Force)) {
      $Name = $Entry.Name
      $Old = Join-Path $Target $Name
      if (-not (Test-Path -LiteralPath $Old)) {
        Move-Noted $Entry.FullName $Old
      } elseif (-not $Entry.PSIsContainer) {
        if (Test-Folder $Old) { throw ($Old + ' is a folder') }
        Move-Noted $Old (Join-Path $Aside $Name)
        Move-Noted $Entry.FullName $Old
      } else {
        if (-not (Test-Folder $Old)) { throw ($Old + ' is not a folder') }
        $Others = @(Get-Files $Old $Name | Where-Object { -not $Own.Contains($_) })
        if ($Others.Count -eq 0) {
          Move-Noted $Old (Join-Path $Aside $Name)
          Move-Noted $Entry.FullName $Old
          Write-Log ('replaced ' + $Old)
        } else {
          Write-Log ('kept ' + $Others.Count + ' file(s) in ' + $Old + ' that are not the app''s, such as ' + $Others[0])
          foreach ($Relative in @(Get-Files $Entry.FullName $Name)) {
            $Place = Join-Path $Target $Relative
            if (Test-Path -LiteralPath $Place) {
              if (Test-Folder $Place) { throw ($Place + ' is a folder') }
              Move-Noted $Place (Join-Path $Aside $Relative)
            }
            Move-Noted (Join-Path $From $Relative) $Place
          }
        }
      }
    }
  } catch {
    $Reason = $_.Exception.Message
    Undo-Noted
    if ($Next) { try { Remove-Tree $Next } catch { Write-Log ('could not remove ' + $Next + ': ' + $_.Exception.Message) } }
    throw $Reason
  }
  $Journal.Clear()

  # For the uninstaller, which removes what it installed itself: what updates
  # put here, the files of this build and those of earlier ones still here.
  try {
    $Files = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($File in $NewFiles) { [void]$Files.Add($File) }
    foreach ($File in $Listed) { if (Test-Path -LiteralPath (Join-Path $Target $File)) { [void]$Files.Add($File) } }
    [IO.File]::WriteAllLines((Join-Path $Target $FileList), [string[]]@($Files | Sort-Object))
  } catch { Write-Log ('could not list the files for the uninstaller: ' + $_.Exception.Message) }
  foreach ($Leftover in @($Aside, $Next)) {
    if ($Leftover) {
      try { Remove-Tree $Leftover } catch { Write-Log ($_.Exception.Message + '; the app removes it at its next start') }
    }
  }
}

# What a move that did not finish left in the installer's folder.
function Remove-Staging {
  foreach ($Leftover in @(Get-ChildItem -LiteralPath $Target -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '.gloom-next-*' -or $_.Name -like '.gloom-previous-*' })) {
    if ((Get-RunningUnder $Leftover.FullName).Count -gt 0) { continue }
    try { Remove-Tree $Leftover.FullName; Write-Log ('removed ' + $Leftover.FullName) } catch { Write-Log $_.Exception.Message }
  }
}

function Open-App([string]$Path) {
  $script:Opened = $true
  try {
    Start-Process -FilePath $Path -WorkingDirectory (Split-Path -Parent $Path)
    Write-Log ('opened ' + $Path)
  } catch { Write-Log ('could not open ' + $Path + ': ' + $_.Exception.Message) }
}

# A value naming a path in $From, naming $To instead; null for any other.
function Get-Retargeted([string]$Value, [string]$From, [string]$To) {
  if (-not $Value) { return $null }
  $Pattern = [regex]::Escape($From) + '(?=[\\/",;]|$)'
  $Evaluator = [System.Text.RegularExpressions.MatchEvaluator] ({ param($Found) $To }.GetNewClosure())
  $Next = [regex]::Replace($Value, $Pattern, $Evaluator, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($Next -ceq $Value) { return $null }
  return $Next
}

# Electrobun's setup makes Desktop and Start menu shortcuts into its folder.
function Update-Shortcuts([string]$From, [string]$To) {
  $Shell = New-Object -ComObject WScript.Shell
  $Folders = @(
    [Environment]::GetFolderPath('Desktop'),
    [Environment]::GetFolderPath('Programs'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Sort-Object -Unique
  foreach ($Folder in $Folders) {
    foreach ($Link in @(Get-ChildItem -LiteralPath $Folder -Filter '*.lnk' -Recurse -File -Force -ErrorAction SilentlyContinue)) {
      try {
        $Shortcut = $Shell.CreateShortcut($Link.FullName)
        $Changed = $false
        foreach ($Field in @('TargetPath', 'WorkingDirectory', 'IconLocation', 'Arguments')) {
          $Next = Get-Retargeted ([string]$Shortcut.$Field) $From $To
          if ($Next) { $Shortcut.$Field = $Next; $Changed = $true }
        }
        if ($Changed) { $Shortcut.Save(); Write-Log ('pointed ' + $Link.FullName + ' at ' + $To) }
      } catch { Write-Log ('could not update ' + $Link.FullName + ': ' + $_.Exception.Message) }
    }
  }
}

# The uninstall entry Electrobun's setup made for its folder goes with the
# folder; the installer's own entry is the one that removes the app.
function Remove-UninstallEntries([string]$Folder) {
  $Uninstall = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($UninstallPath, $true)
  if (-not $Uninstall) { return }
  try {
    foreach ($Name in @($Uninstall.GetSubKeyNames())) {
      if ($Name -eq $InstallerEntry) { continue }
      $Key = $Uninstall.OpenSubKey($Name)
      if (-not $Key) { continue }
      $Location = [string]$Key.GetValue('InstallLocation', '')
      $Key.Close()
      if (Test-Under $Location.TrimEnd('\') $Folder) {
        try { $Uninstall.DeleteSubKeyTree($Name); Write-Log ('removed the uninstall entry ' + $Name) } catch { Write-Log ('could not remove the uninstall entry ' + $Name + ': ' + $_.Exception.Message) }
      }
    }
  } finally { $Uninstall.Close() }
}

# Apps & features shows the version the installer's entry names.
function Set-InstalledVersion {
  try {
    $Version = [string](Get-Content -LiteralPath (Join-Path $Target 'Resources\version.json') -Raw | ConvertFrom-Json).version
    $Key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($UninstallPath + '\' + $InstallerEntry, $true)
    if ($Key) {
      if ($Version) { $Key.SetValue('DisplayVersion', $Version); Write-Log ('the uninstall entry names version ' + $Version) }
      $Key.Close()
    }
  } catch { Write-Log ('could not update the uninstall entry: ' + $_.Exception.Message) }
}

# Moved into this build's app data folder first, out of the way of an update
# installing into the updater's folder meanwhile, and of anything else that
# moves the folders under an identifier.
function Remove-Source([string]$Source) {
  if (-not (Test-Path -LiteralPath $Source)) { return }
  if ((Get-RunningUnder $Source).Count -gt 0) { Write-Log ('left ' + $Source + ': the app runs from it'); return }
  $Doomed = $Source
  if ((Split-Path -Leaf $Source) -notlike 'app.removing-*') {
    New-Item -ItemType Directory -Force -Path $AppData | Out-Null
    $Doomed = Join-Path $AppData ('app.removing-' + (Get-Stamp))
    Invoke-Retried { Move-Item -LiteralPath $Source -Destination $Doomed } ('set aside ' + $Source)
  }
  Invoke-Retried { Remove-Item -LiteralPath $Doomed -Recurse -Force } ('remove ' + $Doomed)
  Write-Log ('removed ' + $Source)
}

# One script at a time: the app opened in the installer's folder removes the
# copy it came from too, and waits for this one.
$Mutex = New-Object System.Threading.Mutex($false, 'Local\GloomInstallerFolder')
$Locked = $false
try {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Log) | Out-Null
  try { $Locked = $Mutex.WaitOne($(if ($AfterExit) { 5000 } else { 120000 })) } catch { $Locked = ($_.Exception.GetBaseException() -is [System.Threading.AbandonedMutexException]) }
  if ($AfterExit) {
    # The app quits only on "started": anything that keeps the move from
    # happening is said before, and the app runs on.
    if (Test-Path -LiteralPath $Cancel) { Write-Log 'the app stopped waiting before this started'; return }
    if (-not $Locked) { Write-Log 'busy: another move of the app runs'; return }
    if (-not (Test-Path -LiteralPath (Join-Path $Sources[0] $Launcher))) { Write-Log ('declined: no ' + $Launcher + ' in ' + $Sources[0]); return }
    $BuildFiles = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($File in @(Get-Files $Sources[0] '')) { [void]$BuildFiles.Add($File) }
    # A build that just quit there for an update can take a moment to go.
    if (-not (Wait-Until 8 { (Get-AppRunningInTarget).Count -eq 0 })) {
      Write-Log ('busy: ' + @(Get-AppRunningInTarget)[0].Path + ' runs'); return
    }
    try {
      $Probe = Join-Path $Target ('.gloom-next-' + (Get-Stamp))
      New-Item -ItemType Directory -Path $Probe | Out-Null
      [IO.Directory]::Delete($Probe, $false)
    } catch { Write-Log ('declined: cannot write in ' + $Target + ': ' + $_.Exception.Message); return }
    Write-Log ('started ' + $PID)
    # The app and its WebView helpers, by where they run from.
    if (-not (Wait-Until 60 { (Get-RunningUnder $Sources[0]).Count -eq 0 })) { throw 'the app did not quit' }
    if (Test-Path -LiteralPath $Cancel) { Write-Log 'the app stopped waiting; it stays where it is'; return }
    $Exited = $true
    if (-not (Wait-Until 30 { (Get-AppRunningInTarget).Count -eq 0 })) { throw ('the app runs from ' + $Target) }
    Install-Build $Sources[0]
    Write-Log ('moved ' + $Sources[0] + ' into ' + $Target)
    Open-App (Join-Path $Target $Launcher)
    Set-InstalledVersion
  } else {
    if (-not $Locked) { throw 'another move of the app runs' }
    Write-Log ('started ' + $PID)
  }
  foreach ($Source in $Sources) {
    try {
      Update-Shortcuts $Source $Target
      Remove-UninstallEntries $Source
      Remove-Source $Source
    } catch { Write-Log ('could not remove ' + $Source + ': ' + $_.Exception.Message) }
  }
  Remove-Staging
  Write-Log 'done'
} catch {
  if ($AfterExit) { Write-Log ('move failed: ' + $_.Exception.Message) } else { Write-Log ('removal failed: ' + $_.Exception.Message) }
  # The app opens again only if it quit for this, from where it was.
  if ($Exited -and -not $Opened) {
    $Open = Join-Path $Sources[0] $Launcher
    if (-not (Test-Path -LiteralPath $Open)) { $Open = Join-Path $Target $Launcher }
    Open-App $Open
  }
} finally {
  $ErrorActionPreference = 'Continue'
  if ($Locked) { try { $Mutex.ReleaseMutex() } catch { } }
  $Mutex.Dispose()
  if ($TaskName) { schtasks.exe /delete /tn $TaskName /f | Out-Null }
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;

/** The script that moves the app into the installer's folder or removes the updater's copy, with its paths written in. */
export function installerFolderScript({ target, sources, folder, log, afterExit }: InstallerFolderScript): string {
  const header = [
    "$ErrorActionPreference = 'Stop'",
    `$Target = ${psString(target)}`,
    `$Sources = @(${sources.map(psString).join(", ")})`,
    `$AppData = ${psString(folder)}`,
    `$Log = ${psString(log)}`,
    `$InstallerEntry = ${psString(INSTALLER_ENTRY)}`,
    `$AfterExit = ${afterExit ? "$true" : "$false"}`,
    `$Cancel = ${psString(afterExit?.cancel ?? "")}`,
    `$TaskName = ${psString(afterExit?.taskName ?? "")}`,
  ];
  return `${header.join("\n")}\n${SCRIPT_BODY}`;
}

/** The tries at moving a build into the installer's folder, kept across starts. */
export interface MoveTries {
  /** The build they were for: its version and hash. */
  build: string;
  /** Tries that failed, or would have: each one the app may have quit for. */
  failed: number;
  /** When the last one started, in ms. */
  last: number;
}

/** Whether the app may try to move `build` now, after `tries`. */
export function mayTryMove(tries: MoveTries | null, build: string, now: number): boolean {
  if (!tries || tries.build !== build) return true;
  return tries.failed < MAX_MOVE_TRIES && now - tries.last >= RETRY_AFTER_MS;
}

/**
 * `tries` with one more for `build` at `now`. Every try counts as failed when
 * it starts: one that works leaves this build's updater folder for good. One
 * the script put off because the installer's folder was in use does not.
 */
export function noteMoveTry(tries: MoveTries | null, build: string, now: number, counts = true): MoveTries {
  const failed = tries?.build === build ? tries.failed : 0;
  return { build, failed: failed + (counts ? 1 : 0), last: now };
}

async function readMoveTries(path: string): Promise<MoveTries | null> {
  const value = await readFile(path, "utf8").then((text) => JSON.parse(text) as Partial<MoveTries>, () => null);
  if (!value || typeof value.build !== "string" || typeof value.failed !== "number" || typeof value.last !== "number") return null;
  return { build: value.build, failed: value.failed, last: value.last };
}

async function writeMoveTries(path: string, tries: MoveTries): Promise<void> {
  await writeFile(path, JSON.stringify(tries), "utf8");
}

/** The build in `appFolder`, by its version and hash. */
async function buildId(appFolder: string): Promise<string> {
  const info = await readFile(win32.join(appFolder, "Resources", "version.json"), "utf8").then((text) => JSON.parse(text) as { version?: unknown; hash?: unknown }, () => null);
  return `${String(info?.version ?? "")}+${String(info?.hash ?? "")}`;
}

/** Where the script, its log and the tries go: the app data folder of this build's identifier. */
function scriptFolder(localAppData: string, channel: string): string {
  return win32.join(localAppData, DESKTOP_APP_IDENTIFIER, channel);
}

async function moveIntoInstallerFolder(
  localAppData: string,
  running: { folder: string; channel: string },
  target: string,
): Promise<InstallerFolderMove> {
  const folder = scriptFolder(localAppData, running.channel);
  const triesPath = win32.join(folder, "installer-folder-tries.json");
  const build = await buildId(running.folder);
  const tries = await readMoveTries(triesPath);
  const now = Date.now();
  if (!mayTryMove(tries, build, now)) return { kind: "skipped" };
  // Noted before the app can quit for it: a try that cannot be noted is not made.
  try {
    await mkdir(folder, { recursive: true });
    await writeMoveTries(triesPath, noteMoveTry(tries, build, now));
  } catch (error) {
    logFailure("desktop-installer-folder", "Could not note a try at moving the app into the installer's folder")(error);
    return { kind: "failed" };
  }
  const log = win32.join(folder, "installer-folder.log");
  const cancel = win32.join(folder, "installer-folder.cancel");
  await rm(log, { force: true });
  await rm(cancel, { force: true });
  const others = (await updaterFolders(localAppData, running.channel)).filter((path) => !samePath(path, running.folder));
  const taskName = `GloomInstallerFolder-${now}`;
  const script = win32.join(folder, "installer-folder-move.ps1");
  try {
    await writePowerShellScript(script, installerFolderScript({
      target,
      sources: [running.folder, ...others],
      folder,
      log,
      afterExit: { cancel, taskName },
    }));
    const answer = await runScriptAfterExit(script, log, cancel, taskName);
    if (answer.kind === "started") return { kind: "relaunching" };
    if (answer.kind === "busy") await writeMoveTries(triesPath, noteMoveTry(tries, build, now, false)).catch(() => {});
    console.error(`[desktop] the app stays where it is, for now: ${answer.reason}`);
    return { kind: "skipped" };
  } catch (error) {
    logFailure("desktop-installer-folder", "Could not run the script that moves the app into the installer's folder")(error);
    return { kind: "failed" };
  }
}

function removeUpdaterCopies(localAppData: string, channel: string, target: string, sources: string[]): InstallerFolderMove {
  const timer = setTimeout(() => {
    const folder = scriptFolder(localAppData, channel);
    const script = win32.join(folder, "installer-folder-cleanup.ps1");
    const log = win32.join(folder, "installer-folder-cleanup.log");
    void mkdir(folder, { recursive: true })
      .then(() => rm(log, { force: true }))
      .then(() => writePowerShellScript(script, installerFolderScript({ target, sources, folder, log })))
      .then(() => runScriptInBackground(script))
      .then((code) => {
        if (code !== 0) throw new Error(`the script exited with ${code}`);
      })
      .catch(logFailure("desktop-installer-folder", "Could not remove the copy of the app an update left"));
  }, REMOVAL_DELAY_MS);
  timer.unref?.();
  return { kind: "removing" };
}

/**
 * Puts an installer install's app in the installer's folder. Anywhere else,
 * and with nothing left in the updater's folder, it returns without writing
 * anything. On `relaunching` the caller quits at once, before any window
 * opens.
 */
export async function settleInstallerFolder(context: InstallerFolderContext): Promise<InstallerFolderMove> {
  if (context.platform !== "win32") return { kind: "none" };
  const localAppData = context.localAppData || win32.join(context.homeDir, "AppData", "Local");
  const read = context.readInstallerFolder ?? readInstallerFolderFromRegistry;

  const running = updaterAppFolder(context.execPath, localAppData);
  if (running) {
    const target = await installerFolder(read);
    if (!target || samePath(target, running.folder)) return { kind: "none" };
    return moveIntoInstallerFolder(localAppData, running, target);
  }

  const bin = win32.dirname(context.execPath);
  if (win32.basename(bin).toLowerCase() !== "bin") return { kind: "none" };
  const app = win32.dirname(bin);
  const channel = await buildChannel(app);
  const copies = await updaterFolders(localAppData, channel);
  const leftovers = (await readdir(app).catch(() => [] as string[])).filter((name) => /^\.gloom-(next|previous)-/i.test(name));
  if (copies.length === 0 && leftovers.length === 0) return { kind: "none" };
  // Only from the installer's folder: a copy run from anywhere else (a
  // portable one) leaves an install from Electrobun's own setup alone.
  const target = await installerFolder(read);
  if (!target || !samePath(target, app)) return { kind: "none" };
  return removeUpdaterCopies(localAppData, channel, target, copies);
}

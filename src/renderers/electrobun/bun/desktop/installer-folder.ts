import { lstat, mkdir, readdir, readFile, rm, stat } from "fs/promises";
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
  /** This process and its launcher, which the script waits for. */
  pid: number;
  ppid: number;
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
  /** The last try at moving the app failed a moment ago; it runs from where it is and tries again later. */
  | { kind: "skipped" }
  | { kind: "failed" };

/** How long a failed move keeps the app from trying again, so a script that cannot move it never makes it quit in a loop. */
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
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
  /** The app runs from `sources[0]`: the script waits for it to quit, moves it into `target` and opens it again. */
  afterExit?: { pids: number[]; taskName: string };
}

// PowerShell 5.1. Only the build's own entries (bin, Resources) are replaced
// in the installer's folder: the installer's uninstaller stays, and so does
// anything else in a folder the user picked. The old ones wait beside it
// until the new ones are all in, and go back if they are not.
const SCRIPT_BODY = String.raw`
$Launcher = 'bin\launcher.exe'
$UninstallPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'

function Write-Log([string]$Message) {
  try { Add-Content -LiteralPath $Log -Value ((Get-Date).ToString('o') + ' ' + $Message) } catch { }
}

function Test-Under([string]$Path, [string]$Root) {
  if (-not $Path) { return $false }
  return $Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Get-RunningUnder([string]$Root) {
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object { try { Test-Under $_.Path $Root } catch { $false } })
}

function Wait-Quiet([string]$Root, [int]$Seconds) {
  for ($Wait = 0; $Wait -lt ($Seconds * 2); $Wait += 1) {
    if ((Get-RunningUnder $Root).Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return ((Get-RunningUnder $Root).Count -eq 0)
}

function Invoke-Retried([scriptblock]$Action, [string]$What) {
  for ($Attempt = 1; $true; $Attempt += 1) {
    try { & $Action | Out-Null; return } catch {
      if ($Attempt -ge 20) { throw ('could not ' + $What + ': ' + $_.Exception.Message) }
      Start-Sleep -Milliseconds 500
    }
  }
}

function Get-Stamp { (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss') }

# A rename on one drive; across drives, a copy and then a removal.
function Move-Tree([string]$From, [string]$To) {
  if ([IO.Path]::GetPathRoot($From) -eq [IO.Path]::GetPathRoot($To)) {
    Invoke-Retried { Move-Item -LiteralPath $From -Destination $To } ('move ' + $From)
    return
  }
  Invoke-Retried {
    if (Test-Path -LiteralPath $To) { Remove-Item -LiteralPath $To -Recurse -Force }
    Copy-Item -LiteralPath $From -Destination $To -Recurse -Force
  } ('copy ' + $From)
  Invoke-Retried { Remove-Item -LiteralPath $From -Recurse -Force } ('remove ' + $From)
}

function Install-Build([string]$From) {
  $Entries = @(Get-ChildItem -LiteralPath $From -Force)
  if (-not (Test-Path -LiteralPath (Join-Path $From $Launcher))) { throw ('no ' + $Launcher + ' in ' + $From) }
  $Aside = $Target + '.previous-' + (Get-Stamp)
  New-Item -ItemType Directory -Force -Path $Aside | Out-Null
  $SetAside = New-Object System.Collections.Generic.List[string]
  $Placed = New-Object System.Collections.Generic.List[string]
  try {
    foreach ($Entry in $Entries) {
      $Name = $Entry.Name
      $Old = Join-Path $Target $Name
      if (Test-Path -LiteralPath $Old) {
        Invoke-Retried { Move-Item -LiteralPath $Old -Destination (Join-Path $Aside $Name) } ('set aside ' + $Old)
        $SetAside.Add($Name)
      }
    }
    foreach ($Entry in $Entries) {
      Move-Tree $Entry.FullName (Join-Path $Target $Entry.Name)
      $Placed.Add($Entry.Name)
    }
  } catch {
    $Reason = $_.Exception.Message
    foreach ($Name in $Placed) {
      try { Move-Tree (Join-Path $Target $Name) (Join-Path $From $Name) } catch { Write-Log ('could not put back ' + $Name + ': ' + $_.Exception.Message) }
    }
    foreach ($Name in $SetAside) {
      try { Move-Item -LiteralPath (Join-Path $Aside $Name) -Destination (Join-Path $Target $Name) } catch { Write-Log ('could not put back the old ' + $Name + ': ' + $_.Exception.Message) }
    }
    Remove-Item -LiteralPath $Aside -Force -ErrorAction SilentlyContinue
    throw $Reason
  }
  try {
    Invoke-Retried { Remove-Item -LiteralPath $Aside -Recurse -Force } ('remove ' + $Aside)
  } catch { Write-Log ($_.Exception.Message + '; the app removes it at its next start') }
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

$Moved = $false
try {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Log) | Out-Null
  Write-Log ('started ' + $PID)
  if ($AppPids.Count -gt 0) {
    foreach ($AppPid in $AppPids) { Wait-Process -Id $AppPid -Timeout 60 -ErrorAction SilentlyContinue }
    if (@($AppPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }).Count -gt 0) { throw 'the app did not quit' }
    # Its WebView helpers go with it, a moment later.
    if (-not (Wait-Quiet $Sources[0] 15)) { throw 'the app did not quit' }
    if (-not (Wait-Quiet $Target 30)) { throw ('something still runs from ' + $Target) }
    Install-Build $Sources[0]
    $Moved = $true
    Write-Log ('moved ' + $Sources[0] + ' into ' + $Target)
    Set-InstalledVersion
  }
  foreach ($Source in $Sources) {
    try {
      Update-Shortcuts $Source $Target
      Remove-UninstallEntries $Source
      Remove-Source $Source
    } catch { Write-Log ('could not remove ' + $Source + ': ' + $_.Exception.Message) }
  }
  Write-Log 'done'
} catch {
  if ($AppPids.Count -gt 0) { Write-Log ('move failed: ' + $_.Exception.Message) } else { Write-Log ('removal failed: ' + $_.Exception.Message) }
} finally {
  $ErrorActionPreference = 'Continue'
  if ($AppPids.Count -gt 0) {
    $Open = Join-Path $Target $Launcher
    if (-not $Moved -and (Test-Path -LiteralPath (Join-Path $Sources[0] $Launcher))) { $Open = Join-Path $Sources[0] $Launcher }
    try {
      Start-Process -FilePath $Open -WorkingDirectory (Split-Path -Parent $Open)
      Write-Log ('opened ' + $Open)
    } catch { Write-Log ('could not open ' + $Open + ': ' + $_.Exception.Message) }
  }
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
    `$AppPids = @(${(afterExit?.pids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0).join(", ")})`,
    `$TaskName = ${psString(afterExit?.taskName ?? "")}`,
  ];
  return `${header.join("\n")}\n${SCRIPT_BODY}`;
}

/** Whether the last move failed a moment ago. */
async function failedRecently(log: string): Promise<boolean> {
  const last = await stat(log).catch(() => null);
  if (!last || Date.now() - last.mtimeMs >= RETRY_AFTER_FAILURE_MS) return false;
  return (await readFile(log, "utf8").catch(() => "")).includes(" move failed: ");
}

/** Where the script and its log go: the app data folder of this build's identifier. */
function scriptFolder(localAppData: string, channel: string): string {
  return win32.join(localAppData, DESKTOP_APP_IDENTIFIER, channel);
}

async function moveIntoInstallerFolder(
  context: InstallerFolderContext,
  localAppData: string,
  running: { folder: string; channel: string },
  target: string,
): Promise<InstallerFolderMove> {
  const folder = scriptFolder(localAppData, running.channel);
  const log = win32.join(folder, "installer-folder.log");
  if (await failedRecently(log)) return { kind: "skipped" };
  await mkdir(folder, { recursive: true });
  await rm(log, { force: true });
  const others = (await updaterFolders(localAppData, running.channel)).filter((path) => !samePath(path, running.folder));
  const taskName = `GloomInstallerFolder-${Date.now()}`;
  const script = win32.join(folder, "installer-folder-move.ps1");
  await writePowerShellScript(script, installerFolderScript({
    target,
    sources: [running.folder, ...others],
    folder,
    log,
    afterExit: { pids: [context.pid, context.ppid], taskName },
  }));
  try {
    await runScriptAfterExit(script, log, taskName);
    return { kind: "relaunching" };
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
    return moveIntoInstallerFolder(context, localAppData, running, target);
  }

  const bin = win32.dirname(context.execPath);
  if (win32.basename(bin).toLowerCase() !== "bin") return { kind: "none" };
  const app = win32.dirname(bin);
  const channel = await buildChannel(app);
  const copies = await updaterFolders(localAppData, channel);
  if (copies.length === 0) return { kind: "none" };
  // Only from the installer's folder: a copy run from anywhere else (a
  // portable one) leaves an install from Electrobun's own setup alone.
  const target = await installerFolder(read);
  if (!target || !samePath(target, app)) return { kind: "none" };
  return removeUpdaterCopies(localAppData, channel, target, copies);
}

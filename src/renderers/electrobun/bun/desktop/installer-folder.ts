import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { win32 } from "path";
import { logFailure } from "../../../../utils/log-failure";
import { DESKTOP_APP_IDENTIFIERS } from "../../shared/app-name";
import { psString, runScriptInBackground, writePowerShellScript } from "./windows-script";

/**
 * Electrobun 2 updates a Windows install only in its own folder,
 * `<local app data>\<identifier>\<channel>\app`: its native update manager
 * refuses any other, and its launcher writes the install's records there
 * (the uninstaller, its Apps & features entry, the Start menu and Desktop
 * shortcuts). The Windows installer (scripts/windows-installer.iss) installs
 * into that folder too.
 *
 * Installer installs from before Electrobun 2 live in the installer's own
 * folder, `Programs\Gloom` unless the user picked another, with the
 * installer's uninstall entry and the `gloom` command's PATH entry leading
 * there. The last of those builds updates into Electrobun's folder and opens
 * this build from it. This build then retires the installer's folder: its
 * own uninstaller removes what it installed, its entry and PATH entry, and
 * the shortcuts it made, which the launcher had just pointed at this folder
 * and which come back here. What it leaves in a folder the installer picked
 * (files the app wrote there) goes too; one the user picked keeps them.
 * It runs in the background, once the window is up. Until it finishes,
 * a file beside the app's folder names the installer's folder, and the next
 * start runs it again: after the old build was still open, its uninstaller
 * failed (its entry stays, for the next try), or a shortcut or PATH could
 * not be written.
 */

/** The installer's AppId, which names its uninstall entry (windows-installer.iss). */
export const WINDOWS_INSTALLER_APP_ID = "{D7B2304C-840B-4E5F-956A-3D1C66E67B35}";
const INSTALLER_ENTRY = `${WINDOWS_INSTALLER_APP_ID}_is1`;

export interface InstallerFolderContext {
  platform: string;
  execPath: string;
  homeDir: string;
  /** `%LOCALAPPDATA%`, under which Electrobun keeps the app's folder. */
  localAppData?: string;
  /** The folder the installer's uninstall entry records, or null; read from the registry when left out. */
  readInstallerFolder?: () => Promise<string | null>;
}

export type InstallerFolderRetirement =
  /** No installer install outside Electrobun's folder, or not from it. */
  | { kind: "none" }
  /** A script retires the installer's folder in the background. */
  | { kind: "retiring"; folder: string };

/** How long after the start the script runs, out of the launch's way. */
const RETIRE_DELAY_MS = 10_000;

/** Beside the app's folder: the installer's folder, while its retirement has not finished. */
const PENDING_FILE = "installer-folder.pending";

function samePath(left: string, right: string): boolean {
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
}

function isDesktopIdentifierName(name: string): boolean {
  return DESKTOP_APP_IDENTIFIERS.some((identifier) => identifier.toLowerCase() === name.toLowerCase());
}

/**
 * Electrobun's folder the app runs from, from its `bin\bun.exe`:
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

// PowerShell 5.1. The installer's uninstaller removes exactly what it
// installed and what earlier builds' moves listed in Resources\update-files.txt,
// with its PATH entry and its shortcuts. Without one (deleted by hand), its
// entry goes here. While the old build runs from the folder, or when its
// uninstaller fails, the entry stays and the next start tries again. The
// Start menu shortcut, and the Desktop one when there was one, then lead to
// this folder; next, what is left in the installer's default folder, which
// holds nothing of the user's, goes; the PATH entry moves last. Each of those
// steps fails on its own, and the script finishes (removing $Pending) only
// once all of them worked.
const SCRIPT_BODY = String.raw`
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $InstallerEntry
$LogEncoding = New-Object System.Text.UTF8Encoding $false

function Write-Log([string]$Message) {
  for ($Attempt = 0; $Attempt -lt 10; $Attempt += 1) {
    try { [IO.File]::AppendAllText($Log, (Get-Date).ToString('o') + ' ' + $Message + [Environment]::NewLine, $LogEncoding); return } catch { Start-Sleep -Milliseconds 100 }
  }
}

function Get-NormalPath([string]$Path) {
  if (-not $Path) { return '' }
  $Path.Trim().Trim('"').TrimEnd('\', '/').ToLowerInvariant()
}

# The programs running from a file in $Folder.
function Get-RunningFrom([string]$Folder) {
  $Prefix = (Get-NormalPath $Folder) + '\'
  @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and (Get-NormalPath $_.Path).StartsWith($Prefix) } catch { $false }
  })
}

# The user's PATH as written, %VARIABLES% unexpanded, and its kind: an
# expanded copy written back would freeze every variable in it.
function Get-UserPath {
  $Key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  try {
    if (-not $Key) { return @{ Value = ''; Kind = [Microsoft.Win32.RegistryValueKind]::ExpandString } }
    $Value = [string]$Key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $Kind = if ($Value) { $Key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    @{ Value = $Value; Kind = $Kind }
  } finally { if ($Key) { $Key.Close() } }
}

function Set-UserPath([string[]]$Entries, $Kind) {
  $Key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  try { $Key.SetValue('Path', ($Entries -join ';'), $Kind) } finally { $Key.Close() }
  # Explorer reads the new PATH for what it opens next once it is told. A
  # user variable set through .NET tells it (WM_SETTINGCHANGE); clearing one
  # that is not there tells it and changes nothing, with no code compiled
  # here for the message.
  [Environment]::SetEnvironmentVariable('GloomPathChanged', $null, 'User')
}

function Update-UserPath([string]$Remove, [string]$Add) {
  $Path = Get-UserPath
  $Entries = @($Path.Value -split ';' | Where-Object { $_.Trim() -and ((Get-NormalPath $_) -ne (Get-NormalPath $Remove)) })
  $Changed = $Entries.Count -ne @($Path.Value -split ';' | Where-Object { $_.Trim() }).Count
  if ($Add -and -not ($Entries | Where-Object { (Get-NormalPath $_) -eq (Get-NormalPath $Add) })) {
    $Entries += $Add
    $Changed = $true
  }
  if ($Changed) {
    Set-UserPath $Entries $Path.Kind
    Write-Log ('PATH leads to ' + $Add + ', not ' + $Remove)
  }
}

function Set-Shortcuts($Wanted) {
  $Shell = New-Object -ComObject WScript.Shell
  $Launcher = Join-Path $App 'bin\launcher.exe'
  foreach ($Shortcut in $Wanted) {
    if (Test-Path -LiteralPath $Shortcut.Path) {
      if ((Get-NormalPath $Shell.CreateShortcut($Shortcut.Path).TargetPath) -eq (Get-NormalPath $Launcher)) { continue }
    }
    $Link = $Shell.CreateShortcut($Shortcut.Path)
    $Link.TargetPath = $Launcher
    $Link.WorkingDirectory = Join-Path $App 'bin'
    $Link.IconLocation = $Launcher + ',0'
    $Link.Save()
    Write-Log ('pointed ' + $Shortcut.Path + ' at ' + $Launcher)
  }
}

$Mutex = New-Object System.Threading.Mutex($false, 'Local\GloomInstallerFolder')
$Locked = $false
try {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Log) | Out-Null
  try { $Locked = $Mutex.WaitOne(0) } catch { $Locked = ($_.Exception.GetBaseException() -is [System.Threading.AbandonedMutexException]) }
  if (-not $Locked) { Write-Log 'busy: another start retires the folder'; return }
  Write-Log ('started: retiring ' + $Folder)
  $Unfinished = @()

  $Shortcuts = @(
    @{ Path = (Join-Path ([Environment]::GetFolderPath('Programs')) 'Gloom.lnk'); Always = $true },
    @{ Path = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Gloom.lnk'); Always = $false }
  )
  $Wanted = @($Shortcuts | Where-Object { $_.Always -or (Test-Path -LiteralPath $_.Path) })

  $Uninstaller = ''
  try { $Uninstaller = ([string](Get-ItemProperty -LiteralPath $UninstallKey -ErrorAction Stop).UninstallString).Trim().Trim('"') } catch { }
  $Running = @()
  if (Test-Path -LiteralPath $UninstallKey) {
    # While the earlier build runs from there its files are locked, and its
    # uninstaller would leave half an install. One that just handed over to
    # this build may still be on its way out.
    for ($Wait = 0; $Wait -lt 60; $Wait += 1) {
      $Running = @(Get-RunningFrom $Folder)
      if (-not $Running.Count) { break }
      Start-Sleep -Milliseconds 500
    }
  }
  if ($Running.Count) {
    $Names = ($Running | ForEach-Object { $_.ProcessName } | Sort-Object -Unique) -join ', '
    Write-Log ('the earlier build still runs from ' + $Folder + ' (' + $Names + '); its uninstall waits for the next start')
    $Unfinished += 'uninstall'
  } elseif ($Uninstaller -and (Test-Path -LiteralPath $Uninstaller)) {
    $Code = $null
    try {
      $Process = Start-Process -FilePath $Uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -PassThru -Wait
      $Code = $Process.ExitCode
      Write-Log ("the installer's uninstaller exited with " + $Code)
    } catch {
      Write-Log ("could not run the installer's uninstaller: " + $_.Exception.Message)
    }
    # It hands over to a copy of itself in the temp folder, which removes the
    # entry last. One that failed has little left to do.
    $Waits = if ($Code -eq 0) { 240 } else { 10 }
    for ($Wait = 0; ($Wait -lt $Waits) -and (Test-Path -LiteralPath $UninstallKey); $Wait += 1) { Start-Sleep -Milliseconds 500 }
    if (Test-Path -LiteralPath $UninstallKey) {
      Write-Log "the installer's uninstaller did not finish; its entry stays for the next start to try again"
      $Unfinished += 'uninstall'
    }
  } elseif (Test-Path -LiteralPath $UninstallKey) {
    Write-Log "the installer's uninstaller is gone; removing its entry here"
    Remove-Item -LiteralPath $UninstallKey -Recurse -Force
  }

  # The uninstaller removed the shortcuts it made, which led there.
  try { Set-Shortcuts $Wanted } catch {
    Write-Log ('could not write the shortcuts: ' + $_.Exception.Message)
    $Unfinished += 'shortcuts'
  }

  # The uninstaller leaves what the app wrote there after the install. That
  # goes too, from a folder the installer picked itself only, and only once
  # the uninstaller is done with it.
  $DefaultFolders = @('Programs\Gloom', 'Programs\Gloomberb') | ForEach-Object { Get-NormalPath (Join-Path $env:LOCALAPPDATA $_) }
  if (($Unfinished -notcontains 'uninstall') -and ($DefaultFolders -contains (Get-NormalPath $Folder))) {
    for ($Wait = 0; ($Wait -lt 20) -and (Test-Path -LiteralPath $Folder); $Wait += 1) { Start-Sleep -Milliseconds 500 }
    if (Test-Path -LiteralPath $Folder) {
      $Left = @(Get-ChildItem -LiteralPath $Folder -Recurse -Force -File -ErrorAction SilentlyContinue | Select-Object -First 5 | ForEach-Object { $_.FullName.Substring($Folder.Length) })
      try {
        Remove-Item -LiteralPath $Folder -Recurse -Force
        Write-Log ('removed ' + $Folder + ', which still held ' + ($Left -join ', '))
      } catch {
        Write-Log ('could not remove ' + $Folder + ': ' + $_.Exception.Message)
        $Unfinished += 'folder'
      }
    }
  }

  try { Update-UserPath (Join-Path $Folder 'bin') (Join-Path $App 'bin') } catch {
    Write-Log ('could not move the PATH entry: ' + $_.Exception.Message)
    $Unfinished += 'PATH'
  }

  if ($Unfinished.Count) {
    Write-Log ('unfinished (' + ($Unfinished -join ', ') + '): the next start tries again')
    exit 2
  }
  Remove-Item -LiteralPath $Pending -Force -ErrorAction SilentlyContinue
  Write-Log 'done'
} catch {
  Write-Log ('failed: ' + $_.Exception.Message)
  exit 1
} finally {
  if ($Locked) { try { $Mutex.ReleaseMutex() } catch { } }
  $Mutex.Dispose()
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;

/**
 * The script that retires the installer's folder `folder` for the app in
 * `app`, with its paths written in. It removes `pending` once it finished.
 */
export function installerFolderScript({ folder, app, log, pending }: { folder: string; app: string; log: string; pending: string }): string {
  const header = [
    "$ErrorActionPreference = 'Stop'",
    `$Folder = ${psString(folder)}`,
    `$App = ${psString(app)}`,
    `$Log = ${psString(log)}`,
    `$Pending = ${psString(pending)}`,
    `$InstallerEntry = ${psString(INSTALLER_ENTRY)}`,
  ];
  return `${header.join("\n")}\n${SCRIPT_BODY}`;
}

/** The installer's folder a retirement that did not finish left in `path`; null without one. */
async function readPendingFolder(path: string): Promise<string | null> {
  const text = await readFile(path, "utf8").catch(() => {
    // Intentional ignore: no pending file, the usual case, means no unfinished retirement.
    return "";
  });
  const folder = text.replace(/^\uFEFF/, "").trim();
  return folder && win32.isAbsolute(folder) ? folder : null;
}

/**
 * Retires an installer install's folder once the app runs from Electrobun's.
 * Anywhere else, and without such an install or a retirement left
 * unfinished, it returns without writing anything.
 */
export async function settleInstallerFolder(context: InstallerFolderContext): Promise<InstallerFolderRetirement> {
  if (context.platform !== "win32") return { kind: "none" };
  const localAppData = context.localAppData || win32.join(context.homeDir, "AppData", "Local");
  const running = updaterAppFolder(context.execPath, localAppData);
  if (!running) return { kind: "none" };
  const channelRoot = win32.dirname(running.folder);
  const pending = win32.join(channelRoot, PENDING_FILE);
  const recorded = await (context.readInstallerFolder ?? readInstallerFolderFromRegistry)().catch(logFailure("desktop-installer-folder", "Could not read the installer's folder from the registry", null))
    ?? await readPendingFolder(pending);
  if (!recorded || samePath(recorded, running.folder)) return { kind: "none" };
  const folder = win32.resolve(recorded);

  const timer = setTimeout(() => {
    const script = win32.join(channelRoot, "installer-folder-retire.ps1");
    const log = win32.join(channelRoot, "installer-folder.log");
    void mkdir(channelRoot, { recursive: true })
      .then(() => writeFile(pending, folder, "utf8"))
      .then(() => writePowerShellScript(script, installerFolderScript({ folder, app: running.folder, log, pending })))
      .then(() => runScriptInBackground(script))
      .then((code) => {
        if (code !== 0) throw new Error(`the script exited with ${code}`);
      })
      .catch(logFailure("desktop-installer-folder", "Could not retire the installer's folder"));
  }, RETIRE_DELAY_MS);
  timer.unref?.();
  return { kind: "retiring", folder };
}

import { mkdir, readFile, rm } from "fs/promises";
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
 * and which come back here. A folder the user picked keeps their own files.
 * It runs in the background, once the window is up, and again at the next
 * start if it did not finish.
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
// entry and PATH entry go here, and the folder only when it is the
// installer's default, which holds nothing of the user's. The Start menu
// shortcut, and the Desktop one when there was one, then lead to this folder.
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
  # Explorer reads the new PATH for what it opens next once it is told.
  if (-not ('GloomEnvironment' -as [type])) {
    Add-Type -Namespace '' -Name GloomEnvironment -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
  }
  $Result = [UIntPtr]::Zero
  [void][GloomEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$Result)
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

$Mutex = New-Object System.Threading.Mutex($false, 'Local\GloomInstallerFolder')
$Locked = $false
try {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Log) | Out-Null
  try { $Locked = $Mutex.WaitOne(0) } catch { $Locked = ($_.Exception.GetBaseException() -is [System.Threading.AbandonedMutexException]) }
  if (-not $Locked) { Write-Log 'busy: another start retires the folder'; return }
  Write-Log ('started: retiring ' + $Folder)

  $Shell = New-Object -ComObject WScript.Shell
  $Shortcuts = @(
    @{ Path = (Join-Path ([Environment]::GetFolderPath('Programs')) 'Gloom.lnk'); Always = $true },
    @{ Path = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Gloom.lnk'); Always = $false }
  )
  $Wanted = @($Shortcuts | Where-Object { $_.Always -or (Test-Path -LiteralPath $_.Path) })

  $Uninstaller = ''
  try { $Uninstaller = ([string](Get-ItemProperty -LiteralPath $UninstallKey -ErrorAction Stop).UninstallString).Trim().Trim('"') } catch { }
  if ($Uninstaller -and (Test-Path -LiteralPath $Uninstaller)) {
    $Process = Start-Process -FilePath $Uninstaller -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -PassThru -Wait
    Write-Log ("the installer's uninstaller exited with " + $Process.ExitCode)
    # It hands over to a copy of itself in the temp folder, which removes the entry last.
    for ($Wait = 0; ($Wait -lt 240) -and (Test-Path -LiteralPath $UninstallKey); $Wait += 1) { Start-Sleep -Milliseconds 500 }
  }
  if (Test-Path -LiteralPath $UninstallKey) {
    Write-Log "the installer's entry is still there; removing it here"
    Remove-Item -LiteralPath $UninstallKey -Recurse -Force
    foreach ($Default in @('Programs\Gloom', 'Programs\Gloomberb')) {
      $DefaultFolder = Join-Path $env:LOCALAPPDATA $Default
      if (((Get-NormalPath $DefaultFolder) -eq (Get-NormalPath $Folder)) -and (Test-Path -LiteralPath $Folder)) {
        Remove-Item -LiteralPath $Folder -Recurse -Force
        Write-Log ('removed ' + $Folder)
      }
    }
  }
  Update-UserPath (Join-Path $Folder 'bin') (Join-Path $App 'bin')

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

/** The script that retires the installer's folder `folder` for the app in `app`, with its paths written in. */
export function installerFolderScript({ folder, app, log }: { folder: string; app: string; log: string }): string {
  const header = [
    "$ErrorActionPreference = 'Stop'",
    `$Folder = ${psString(folder)}`,
    `$App = ${psString(app)}`,
    `$Log = ${psString(log)}`,
    `$InstallerEntry = ${psString(INSTALLER_ENTRY)}`,
  ];
  return `${header.join("\n")}\n${SCRIPT_BODY}`;
}

/**
 * Retires an installer install's folder once the app runs from Electrobun's.
 * Anywhere else, and without such an install, it returns without writing
 * anything.
 */
export async function settleInstallerFolder(context: InstallerFolderContext): Promise<InstallerFolderRetirement> {
  if (context.platform !== "win32") return { kind: "none" };
  const localAppData = context.localAppData || win32.join(context.homeDir, "AppData", "Local");
  const running = updaterAppFolder(context.execPath, localAppData);
  if (!running) return { kind: "none" };
  const recorded = await (context.readInstallerFolder ?? readInstallerFolderFromRegistry)().catch(() => null);
  if (!recorded || samePath(recorded, running.folder)) return { kind: "none" };
  const folder = win32.resolve(recorded);

  const channelRoot = win32.dirname(running.folder);
  const timer = setTimeout(() => {
    const script = win32.join(channelRoot, "installer-folder-retire.ps1");
    const log = win32.join(channelRoot, "installer-folder.log");
    void mkdir(channelRoot, { recursive: true })
      .then(() => writePowerShellScript(script, installerFolderScript({ folder, app: running.folder, log })))
      .then(() => runScriptInBackground(script))
      .then((code) => {
        if (code !== 0) throw new Error(`the script exited with ${code}`);
      })
      .catch(logFailure("desktop-installer-folder", "Could not retire the installer's folder"));
  }, RETIRE_DELAY_MS);
  timer.unref?.();
  return { kind: "retiring", folder };
}

import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { dirname, join, win32 } from "path";
import { logFailure } from "../../../../utils/log-failure";
import { DESKTOP_APP_IDENTIFIER, LEGACY_DESKTOP_APP_IDENTIFIER } from "../../shared/app-name";

/**
 * Electrobun names the app's folders after its bundle identifier:
 * `<app data>/<identifier>/<channel>`, holding the downloaded updates
 * (`self-extraction`) and, on Windows, the WebView's storage (`CEF`) and the
 * app itself (`app`): its updates install there, and the shortcuts and
 * uninstall entry its setup made point there. An install from before the
 * identifier changed keeps all of it under the old one, and this build would
 * start new folders beside it.
 *
 * So at its first start this build moves them under the new identifier. On a
 * Mac it moves the folder in Application Support itself. On Windows a
 * PowerShell script moves it and points the shortcuts and uninstall entries
 * that led into it at the new place. When the app runs from the old folder
 * (its updater installed this build there), the script waits for the app to
 * quit, moves it and opens it again from the new folder.
 */

export interface AppIdentifierMoveContext {
  platform: string;
  execPath: string;
  homeDir: string;
  /** `%LOCALAPPDATA%`, where Electrobun keeps the folders on Windows. */
  localAppData?: string;
  /** This process and its launcher, which the Windows script waits for. */
  pid: number;
  ppid: number;
}

export type AppIdentifierMove =
  /** Nothing under the old identifier. */
  | { kind: "none" }
  /** Moved, or (Windows) being moved while the app runs. */
  | { kind: "moved" | "moving" }
  /** Windows: the app runs from the old folder, and quits for the script to move it and open it again. */
  | { kind: "relaunching" }
  /** The last try at moving the running app did not get it out; it runs from where it is and tries again later. */
  | { kind: "skipped" }
  | { kind: "failed" };

interface AppIdentifierFolders {
  legacy: string;
  current: string;
}

function appIdentifierFolders(context: AppIdentifierMoveContext): AppIdentifierFolders | null {
  if (context.platform === "darwin") {
    const root = join(context.homeDir, "Library", "Application Support");
    return { legacy: join(root, LEGACY_DESKTOP_APP_IDENTIFIER), current: join(root, DESKTOP_APP_IDENTIFIER) };
  }
  if (context.platform === "win32") {
    const root = context.localAppData || win32.join(context.homeDir, "AppData", "Local");
    return { legacy: win32.join(root, LEGACY_DESKTOP_APP_IDENTIFIER), current: win32.join(root, DESKTOP_APP_IDENTIFIER) };
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true, () => false);
}

async function moveMissing(from: string, to: string, depth: number): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    const there = await lstat(target).catch(() => null);
    if (!there) await rename(source, target);
    else if (depth > 1 && entry.isDirectory() && there.isDirectory()) await moveMissing(source, target, depth - 1);
  }
}

/**
 * Moves `legacy` to `current`, or, when this build already made `current`,
 * what `legacy` holds that it lacks, down to `<channel>/<folder>`; what both
 * hold stays as this build wrote it. Then `legacy` goes. A move that fails
 * throws with `legacy` still there, and the next start finishes it.
 */
async function mergeLegacyFolder(legacy: string, current: string): Promise<void> {
  if (!(await exists(legacy))) return;
  if (!(await exists(current))) {
    await mkdir(dirname(current), { recursive: true });
    await rename(legacy, current);
    return;
  }
  await moveMissing(legacy, current, 2);
  await rm(legacy, { recursive: true, force: true });
}

/**
 * Where the app runs from below the old Windows folder, from its
 * `<channel>\app\bin\bun.exe`: the app's folder and its launcher, relative to
 * the identifier's folder. Null when it runs from anywhere else (the
 * installer's `Programs\Gloom`).
 */
export function legacyWindowsApp(execPath: string, legacy: string): { folder: string; launcher: string } | null {
  const prefix = `${legacy}\\`;
  if (execPath.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) return null;
  const parts = execPath.slice(prefix.length).split(/[\\/]+/);
  if (parts.length < 4 || parts.at(-2)?.toLowerCase() !== "bin") return null;
  const app = parts.slice(0, -2).join("\\");
  return { folder: win32.join(legacy, app), launcher: win32.join(app, "bin", "launcher.exe") };
}

function psString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

interface WindowsMoveScript {
  legacy: string;
  current: string;
  /** The app runs from the old folder: the script waits for it to quit and opens it again. */
  afterExit?: {
    pids: number[];
    /** The folder it runs from, whose WebView helpers it also waits for. */
    folder: string;
    /** Its launcher, relative to either identifier's folder. */
    launcher: string;
    /** The scheduled task that runs the script, which it removes. */
    taskName: string;
  };
}

// PowerShell 5.1, which every supported Windows has. The app goes last, and
// only once everything else has moved: a shortcut is pointed at the new
// folder only when the whole folder made it there, so it never leads nowhere.
// When the app runs from the old folder, the old folder's copy of anything is
// the one to keep (this build has only just made the new folder); otherwise
// the new folder's is.
const WINDOWS_MOVE_SCRIPT_BODY = String.raw`
$Log = Join-Path $Current 'identifier-move.log'

function Write-Log([string]$Message) {
  try { Add-Content -LiteralPath $Log -Value ((Get-Date).ToString('o') + ' ' + $Message) } catch { }
}

function Test-Under([string]$Path, [string]$Root) {
  if (-not $Path) { return $false }
  return $Path.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -or $Path.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-Retried([scriptblock]$Action, [string]$What) {
  for ($Attempt = 1; $true; $Attempt += 1) {
    try { & $Action | Out-Null; return $true } catch {
      if ($Attempt -ge 20) { Write-Log ('could not ' + $What + ': ' + $_.Exception.Message); return $false }
      Start-Sleep -Milliseconds 500
    }
  }
}

function Move-Entry($Entry, [string]$Target) {
  if (Test-Path -LiteralPath $Target) {
    if (-not $OldWins) { return $true }
    if (-not (Invoke-Retried { Remove-Item -LiteralPath $Target -Recurse -Force } ('replace ' + $Target))) { return $false }
  }
  return (Invoke-Retried { Move-Item -LiteralPath $Entry.FullName -Destination $Target } ('move ' + $Entry.FullName))
}

# A value naming a path in the old folder, naming the new one instead; null for any other.
function Get-Moved([string]$Value) {
  if (-not $Value) { return $null }
  $Pattern = [regex]::Escape($Legacy) + '(?=[\\/",;]|$)'
  $Evaluator = [System.Text.RegularExpressions.MatchEvaluator] { param($Found) $Current }
  $Next = [regex]::Replace($Value, $Pattern, $Evaluator, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($Next -ceq $Value) { return $null }
  return $Next
}

function Update-Shortcuts {
  $Shell = New-Object -ComObject WScript.Shell
  $Folders = @(
    [Environment]::GetFolderPath('Desktop'),
    (Join-Path $env:USERPROFILE 'Desktop'),
    [Environment]::GetFolderPath('Programs'),
    (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Sort-Object -Unique
  foreach ($Folder in $Folders) {
    foreach ($Link in @(Get-ChildItem -LiteralPath $Folder -Filter '*.lnk' -Recurse -File -Force -ErrorAction SilentlyContinue)) {
      try {
        $Shortcut = $Shell.CreateShortcut($Link.FullName)
        $Changed = $false
        foreach ($Field in @('TargetPath', 'WorkingDirectory', 'IconLocation', 'Arguments')) {
          $Next = Get-Moved ([string]$Shortcut.$Field)
          if ($Next) { $Shortcut.$Field = $Next; $Changed = $true }
        }
        if ($Changed) { $Shortcut.Save(); Write-Log ('pointed ' + $Link.FullName + ' at the new folder') }
      } catch { Write-Log ('could not update ' + $Link.FullName + ': ' + $_.Exception.Message) }
    }
  }
}

# Electrobun's setup writes an uninstall entry named after the identifier
# (and a .reg file of it beside the app); any entry may name the folder.
function Update-UninstallEntries {
  $UninstallPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall'
  $Uninstall = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($UninstallPath, $true)
  if ($Uninstall) {
    foreach ($Name in @($Uninstall.GetSubKeyNames())) {
      try {
        $Key = $Uninstall.OpenSubKey($Name, $true)
        if (-not $Key) { continue }
        foreach ($ValueName in @($Key.GetValueNames())) {
          $Kind = $Key.GetValueKind($ValueName)
          if ($Kind -ne [Microsoft.Win32.RegistryValueKind]::String -and $Kind -ne [Microsoft.Win32.RegistryValueKind]::ExpandString) { continue }
          $Next = Get-Moved ([string]$Key.GetValue($ValueName, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))
          if ($Next) { $Key.SetValue($ValueName, $Next, $Kind); Write-Log ('pointed uninstall entry ' + $Name + ' at the new folder') }
        }
        $Key.Close()
      } catch { Write-Log ('could not update uninstall entry ' + $Name + ': ' + $_.Exception.Message) }
    }
    $Names = @($Uninstall.GetSubKeyNames())
    if (($Names -contains $LegacyIdentifier) -and -not ($Names -contains $CurrentIdentifier)) {
      try {
        Rename-Item -LiteralPath ('HKCU:\' + $UninstallPath + '\' + $LegacyIdentifier) -NewName $CurrentIdentifier
        Write-Log ('renamed uninstall entry ' + $LegacyIdentifier + ' to ' + $CurrentIdentifier)
      } catch { Write-Log ('could not rename uninstall entry ' + $LegacyIdentifier + ': ' + $_.Exception.Message) }
    }
    $Uninstall.Close()
  }
  foreach ($Channel in @(Get-ChildItem -LiteralPath $Current -Directory -Force -ErrorAction SilentlyContinue)) {
    $App = Join-Path $Channel.FullName 'app'
    foreach ($Reg in @(Get-ChildItem -LiteralPath $App -Filter '*_uninstall.reg' -File -ErrorAction SilentlyContinue)) {
      try {
        $Text = [IO.File]::ReadAllText($Reg.FullName)
        $Next = Get-Moved $Text
        if (-not $Next) { $Next = $Text }
        $Next = $Next.Replace('\Uninstall\' + $LegacyIdentifier + ']', '\Uninstall\' + $CurrentIdentifier + ']')
        if ($Next -cne $Text) { [IO.File]::WriteAllText($Reg.FullName, $Next); Write-Log ('pointed ' + $Reg.FullName + ' at the new folder') }
      } catch { Write-Log ('could not update ' + $Reg.FullName + ': ' + $_.Exception.Message) }
    }
  }
}

$Reopen = $false
try {
  New-Item -ItemType Directory -Force -Path $Current | Out-Null
  Write-Log ('started ' + $PID)

  if ($AppPids.Count -gt 0) {
    foreach ($AppPid in $AppPids) { Wait-Process -Id $AppPid -Timeout 60 -ErrorAction SilentlyContinue }
    if (@($AppPids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue }).Count -gt 0) { throw 'the app did not quit' }
    $Reopen = $true
    # Its WebView helpers go with it, a moment later.
    for ($Wait = 0; $Wait -lt 30; $Wait += 1) {
      $Left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { try { Test-Under $_.Path $AppFolder } catch { $false } })
      if ($Left.Count -eq 0) { break }
      Start-Sleep -Milliseconds 500
    }
  }

  $Apps = @()
  $Complete = $true
  foreach ($Entry in @(Get-ChildItem -LiteralPath $Legacy -Force)) {
    $Target = Join-Path $Current $Entry.Name
    if (-not $Entry.PSIsContainer) {
      if (-not (Move-Entry $Entry $Target)) { $Complete = $false }
      continue
    }
    if (-not (Test-Path -LiteralPath $Target)) { New-Item -ItemType Directory -Force -Path $Target | Out-Null }
    foreach ($Child in @(Get-ChildItem -LiteralPath $Entry.FullName -Force)) {
      # Left by the update that installed this build; it removes itself.
      if ($Child.Name -eq 'update.bat') { continue }
      if ($Child.Name -eq 'app' -and $Child.PSIsContainer) { $Apps += $Child; continue }
      if (-not (Move-Entry $Child (Join-Path $Target $Child.Name))) { $Complete = $false }
    }
  }
  if ($Complete) {
    foreach ($App in $Apps) {
      if (-not (Move-Entry $App (Join-Path (Join-Path $Current $App.Parent.Name) 'app'))) { $Complete = $false }
    }
  }
  if (-not $Complete) { throw 'the old folder did not move whole; nothing points at the new one' }

  Update-Shortcuts
  Update-UninstallEntries
  if (Invoke-Retried { Remove-Item -LiteralPath $Legacy -Recurse -Force } ('remove ' + $Legacy)) {
    Write-Log ('moved ' + $Legacy + ' to ' + $Current)
  }
} catch {
  Write-Log ('failed: ' + $_.Exception.Message)
} finally {
  $ErrorActionPreference = 'Continue'
  if ($Reopen -and $Launcher) {
    $Open = Join-Path $Current $Launcher
    if (-not (Test-Path -LiteralPath $Open)) { $Open = Join-Path $Legacy $Launcher }
    try {
      Start-Process -FilePath $Open -WorkingDirectory (Split-Path -Parent $Open)
      Write-Log ('opened ' + $Open)
    } catch { Write-Log ('could not open ' + $Open + ': ' + $_.Exception.Message) }
  }
  if ($TaskName) { schtasks.exe /delete /tn $TaskName /f | Out-Null }
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;

/** The script that moves the old Windows folder, with its paths written in. */
export function windowsIdentifierMoveScript({ legacy, current, afterExit }: WindowsMoveScript): string {
  const header = [
    "$ErrorActionPreference = 'Stop'",
    `$Legacy = ${psString(legacy)}`,
    `$Current = ${psString(current)}`,
    `$LegacyIdentifier = ${psString(LEGACY_DESKTOP_APP_IDENTIFIER)}`,
    `$CurrentIdentifier = ${psString(DESKTOP_APP_IDENTIFIER)}`,
    `$AppPids = @(${(afterExit?.pids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0).join(", ")})`,
    `$AppFolder = ${psString(afterExit?.folder ?? "")}`,
    `$Launcher = ${psString(afterExit?.launcher ?? "")}`,
    `$TaskName = ${psString(afterExit?.taskName ?? "")}`,
    `$OldWins = ${afterExit ? "$true" : "$false"}`,
  ];
  return `${header.join("\r\n")}\r\n${WINDOWS_MOVE_SCRIPT_BODY.replaceAll(/\r?\n/g, "\r\n")}`;
}

/** How long a try at moving the running app counts as the last one. */
const RECENT_ATTEMPT_MS = 10 * 60_000;
/** How long the script has to say it started before the app stops waiting and keeps running. */
const SCRIPT_START_TIMEOUT_MS = 20_000;

function powershellCommand(script: string): string[] {
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script];
}

async function writeScript(folders: AppIdentifierFolders, text: string): Promise<string> {
  await mkdir(folders.current, { recursive: true });
  const path = win32.join(folders.current, "identifier-move.ps1");
  // With a byte order mark: PowerShell 5.1 reads a script without one in the
  // system code page, which would garble a path with an accent in it.
  await writeFile(path, `\uFEFF${text}`, "utf8");
  return path;
}

async function startedScript(log: string): Promise<boolean> {
  const deadline = Date.now() + SCRIPT_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await readFile(log, "utf8").catch(() => "")).includes(" started ")) return true;
    await Bun.sleep(250);
  }
  return false;
}

/**
 * The app runs from the old folder, where its files are locked while it
 * runs: a scheduled task (which outlives the app, unlike a child of its
 * process) runs the script once the app has quit. The app quits only once the
 * script has said it started. A try that did not get the app out (the script
 * could not move it, or never ran) leaves it running from where it is until a
 * later start.
 */
async function moveRunningWindowsApp(context: AppIdentifierMoveContext, folders: AppIdentifierFolders, app: { folder: string; launcher: string }): Promise<AppIdentifierMove> {
  const log = win32.join(folders.current, "identifier-move.log");
  const last = await stat(log).catch(() => null);
  if (last && Date.now() - last.mtimeMs < RECENT_ATTEMPT_MS) return { kind: "skipped" };
  await rm(log, { force: true });
  const taskName = `GloomIdentifierMove-${Date.now()}`;
  const script = await writeScript(folders, windowsIdentifierMoveScript({
    ...folders,
    afterExit: { pids: [context.pid, context.ppid], folder: app.folder, launcher: app.launcher, taskName },
  }));
  const command = powershellCommand(script).map((part) => (part === script ? `"${part}"` : part)).join(" ");
  const schtasks = (...args: string[]) => {
    const result = Bun.spawnSync(["schtasks.exe", ...args], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    if (!result.success) throw new Error(`schtasks ${args[0]}: ${result.stderr.toString().trim()}`);
  };
  try {
    schtasks("/create", "/tn", taskName, "/tr", command, "/sc", "once", "/st", "00:00", "/f");
    schtasks("/run", "/tn", taskName);
    if (!(await startedScript(log))) throw new Error("it did not start");
    return { kind: "relaunching" };
  } catch (error) {
    try { schtasks("/delete", "/tn", taskName, "/f"); } catch { /* Intentional ignore: never created. */ }
    logFailure("desktop-app-identifier", "Could not run the script that moves the app to its new folder")(error);
    return { kind: "failed" };
  }
}

/** How long after the start the old folder beside a running app is moved, out of the launch's way. */
const BACKGROUND_MOVE_DELAY_MS = 15_000;

/** The app runs from elsewhere: the script moves the old folder in the background, a while after the start. */
function moveWindowsFolder(folders: AppIdentifierFolders): AppIdentifierMove {
  const timer = setTimeout(() => {
    void writeScript(folders, windowsIdentifierMoveScript(folders)).then((script) => {
      const child = Bun.spawn(powershellCommand(script), { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
      return child.exited;
    }).then((code) => {
      if (code !== 0) throw new Error(`the script exited with ${code}`);
    }).catch(logFailure("desktop-app-identifier", "Could not move the app's old folder"));
  }, BACKGROUND_MOVE_DELAY_MS);
  timer.unref?.();
  return { kind: "moving" };
}

/**
 * Moves the app's folders from the old identifier to this one, once, at the
 * first start of a build under it. Anywhere with nothing under the old one it
 * returns without writing anything. On `relaunching` the caller quits at
 * once, before any window opens.
 */
export async function moveLegacyAppIdentifierFolders(context: AppIdentifierMoveContext): Promise<AppIdentifierMove> {
  const folders = appIdentifierFolders(context);
  if (!folders || !(await exists(folders.legacy))) return { kind: "none" };
  if (context.platform === "darwin") {
    await mergeLegacyFolder(folders.legacy, folders.current);
    return { kind: "moved" };
  }
  const app = legacyWindowsApp(context.execPath, folders.legacy);
  return app ? moveRunningWindowsApp(context, folders, app) : moveWindowsFolder(folders);
}

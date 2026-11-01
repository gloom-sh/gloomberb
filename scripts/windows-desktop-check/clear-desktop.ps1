# Clears what the windows-11-arm runner image leaves over its desktop, where
# it takes the input the check sends the app: the privacy settings screen of a
# first sign-in (WWAHost.exe, started by UserOOBEBroker.exe), an open Start
# menu, other windows left open, and the `wsl.exe --update` terminal it keeps
# opening in the foreground. Electron's CI does the same on that image.
#
#   pwsh scripts/windows-desktop-check/clear-desktop.ps1 -Log <file> [-Minutes 90]
#
# Clears the desktop once, then leaves a hidden Windows PowerShell minimizing
# each new WSL terminal for -Minutes, writing what it did to -Log.
param(
  [Parameter(Mandatory = $true)][string]$Log,
  [int]$Minutes = 90,
  [switch]$Watch
)

$ErrorActionPreference = "Stop"

Add-Type -Namespace GloomCheck -Name Desktop -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int size);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int size);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string windowClass, string title);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
[DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
[DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);

public static bool Cloaked(IntPtr hWnd) {
  int cloaked = 0;
  return DwmGetWindowAttribute(hWnd, 14, out cloaked, 4) == 0 && cloaked != 0;
}

public static string Describe(IntPtr hWnd) {
  var windowClass = new System.Text.StringBuilder(256);
  var title = new System.Text.StringBuilder(256);
  GetClassName(hWnd, windowClass, 256);
  GetWindowText(hWnd, title, 256);
  uint processId;
  GetWindowThreadProcessId(hWnd, out processId);
  string process = "?";
  try { process = System.Diagnostics.Process.GetProcessById((int)processId).ProcessName; } catch {}
  return string.Format("class '{0}' title '{1}' process {2} ({3})", windowClass, title, process, processId);
}

// The visible, uncloaked top-level windows but the shell's desktop and taskbar.
public static System.Collections.Generic.List<IntPtr> OpenWindows() {
  var shell = new System.Collections.Generic.HashSet<string> { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd" };
  var found = new System.Collections.Generic.List<IntPtr>();
  EnumWindows((hWnd, lParam) => {
    if (!IsWindowVisible(hWnd) || IsIconic(hWnd) || Cloaked(hWnd)) return true;
    var windowClass = new System.Text.StringBuilder(256);
    GetClassName(hWnd, windowClass, 256);
    if (!shell.Contains(windowClass.ToString())) found.Add(hWnd);
    return true;
  }, IntPtr.Zero);
  return found;
}

// A Windows Terminal window is titled "Terminal" until its tab names the
// command; a console window running wsl.exe itself is titled with it.
public static bool IsWslTerminal(IntPtr hWnd) {
  var windowClass = new System.Text.StringBuilder(64);
  var title = new System.Text.StringBuilder(256);
  GetClassName(hWnd, windowClass, 64);
  GetWindowText(hWnd, title, 256);
  bool wsl = title.ToString().IndexOf("wsl.exe", StringComparison.OrdinalIgnoreCase) >= 0;
  if (windowClass.ToString() == "CASCADIA_HOSTING_WINDOW_CLASS") return wsl || title.ToString() == "Terminal";
  return windowClass.ToString() == "ConsoleWindowClass" && wsl;
}
'@

function Write-Log([string]$Line) {
  $Stamped = "$([DateTime]::UtcNow.ToString('HH:mm:ss.fff')) $Line"
  Add-Content -LiteralPath $Log -Value $Stamped
  if (-not $Watch) { Write-Host $Stamped }
}

if ($Watch) {
  $Seen = @{}
  $Deadline = [DateTime]::UtcNow.AddMinutes($Minutes)
  while ([DateTime]::UtcNow -lt $Deadline) {
    foreach ($Window in [GloomCheck.Desktop]::OpenWindows()) {
      if (-not [GloomCheck.Desktop]::IsWslTerminal($Window)) { continue }
      [void][GloomCheck.Desktop]::ShowWindow($Window, 6)
      if (-not $Seen.ContainsKey($Window)) {
        $Seen[$Window] = $true
        Write-Log "minimized a WSL terminal: $([GloomCheck.Desktop]::Describe($Window))"
      }
    }
    Start-Sleep -Milliseconds 200
  }
  exit 0
}

if (-not [IO.Path]::IsPathRooted($Log)) { $Log = Join-Path (Get-Location).Path $Log }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Log) | Out-Null

# The privacy settings screen, kept from coming back at a later sign-in.
$Policy = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\OOBE"
New-Item -Path $Policy -Force | Out-Null
Set-ItemProperty -Path $Policy -Name DisablePrivacyExperience -Type DWord -Value 1
$Engagement = "HKCU:\Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement"
New-Item -Path $Engagement -Force | Out-Null
Set-ItemProperty -Path $Engagement -Name ScoobeSystemSettingEnabled -Type DWord -Value 0
foreach ($Name in @("UserOOBEBroker", "WWAHost")) {
  Get-Process -Name $Name -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Log "stopped $($_.ProcessName) ($($_.Id)) '$($_.MainWindowTitle)'"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
}

# The `wsl.exe --update` running now; the watcher minimizes the ones after it.
Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" | Where-Object { $_.CommandLine -match "--update" } | ForEach-Object {
  Write-Log "stopped wsl.exe ($($_.ProcessId)) $($_.CommandLine)"
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

# The Start menu's window always exists, cloaked while the menu is closed.
$Start = [GloomCheck.Desktop]::FindWindow("Windows.UI.Core.CoreWindow", "Start")
if ($Start -ne [IntPtr]::Zero -and [GloomCheck.Desktop]::IsWindowVisible($Start) -and -not [GloomCheck.Desktop]::Cloaked($Start)) {
  [GloomCheck.Desktop]::keybd_event(0x1B, 0, 0, [UIntPtr]::Zero)
  [GloomCheck.Desktop]::keybd_event(0x1B, 0, 2, [UIntPtr]::Zero)
  Write-Log "closed the Start menu"
  Start-Sleep -Seconds 1
}

for ($Pass = 1; $Pass -le 3; $Pass++) {
  $Open = [GloomCheck.Desktop]::OpenWindows()
  if ($Open.Count -eq 0) { break }
  foreach ($Window in $Open) {
    [void][GloomCheck.Desktop]::ShowWindow($Window, 6)
    Write-Log "minimized $([GloomCheck.Desktop]::Describe($Window))"
  }
  Start-Sleep -Seconds 1
}

$Point = New-Object GloomCheck.Desktop+POINT
$Point.X = 960; $Point.Y = 540
$Under = [GloomCheck.Desktop]::GetAncestor([GloomCheck.Desktop]::WindowFromPoint($Point), 2)
Write-Log "at the screen's middle: $([GloomCheck.Desktop]::Describe($Under))"

# Windows PowerShell, detached from this step's output so the step can end.
$Script = $MyInvocation.MyCommand.Path
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$Script`"", "-Log", "`"$Log`"", "-Minutes", $Minutes, "-Watch"
)
Write-Log "watching for WSL terminals for $Minutes minutes"

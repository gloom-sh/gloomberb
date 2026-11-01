# Drives the app's main window the way a person does, with the real mouse and
# keyboard, and writes what happened as JSON:
#
# - the window's style bits (a sizing frame and a maximize box are what let
#   Windows snap and maximize it);
# - what Windows says sits at each edge and corner (a resize hit code, or the
#   page), and whether dragging there with the mouse resizes the window;
# - whether the webview inside follows a resize, and how long it takes;
# - the minimum size, set programmatically and by dragging;
# - maximize by ShowWindow and by Win+Up, against the monitor's work area;
# - snap left and right with Win+Left / Win+Right;
# - minimize and restore;
# - closing the window: how long until every process of the app has exited.
#
# With -FrameOnly it only reports the main window's frame (used after a
# relaunch, to see whether the frame the app was closed at came back).
param(
  [Parameter(Mandatory = $true)][string]$Pids,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$ScreenshotDir = "",
  [switch]$FrameOnly,
  [switch]$ListOnly
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfoW(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);

  public static List<IntPtr> TopLevel(HashSet<uint> pids) {
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pids.Contains(pid) && IsWindowVisible(h)) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static List<IntPtr> Children(IntPtr parent) {
    var found = new List<IntPtr>();
    EnumChildWindows(parent, (h, l) => { found.Add(h); return true; }, IntPtr.Zero);
    return found;
  }

  public static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
  public static string TitleOf(IntPtr h) { var sb = new StringBuilder(256); GetWindowTextW(h, sb, 256); return sb.ToString(); }

  public static RECT Visible(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return r;
  }

  public static RECT Work(IntPtr h) {
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    GetMonitorInfoW(MonitorFromWindow(h, 2), ref mi);
    return mi.rcWork;
  }

  public static RECT Monitor(IntPtr h) {
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    GetMonitorInfoW(MonitorFromWindow(h, 2), ref mi);
    return mi.rcMonitor;
  }

  public static int HitTest(IntPtr h, int x, int y) {
    uint l = (((uint)y & 0xFFFFu) << 16) | ((uint)x & 0xFFFFu);
    return (int)(long)SendMessageW(h, 0x0084, IntPtr.Zero, new IntPtr((long)l));
  }

  public static void Down() { mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); }
  public static void Up() { mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); }
  public static void Key(byte vk, bool up) { keybd_event(vk, 0, (uint)((up ? 0x0002 : 0) | ((vk >= 0x21 && vk <= 0x2E) || vk == 0x5B ? 0x0001 : 0)), UIntPtr.Zero); }
}
"@

[void][W]::SetProcessDPIAware()

$PidSet = New-Object 'System.Collections.Generic.HashSet[uint32]'
foreach ($Id in ($Pids -split ",")) { if ($Id) { [void]$PidSet.Add([uint32]$Id) } }

function Rect-Object($R) { [ordered]@{ x = $R.Left; y = $R.Top; width = $R.Right - $R.Left; height = $R.Bottom - $R.Top } }

function Main-Window {
  $Best = [IntPtr]::Zero
  $BestArea = 0
  foreach ($H in [W]::TopLevel($PidSet)) {
    $R = [W]::Visible($H)
    $Area = ($R.Right - $R.Left) * ($R.Bottom - $R.Top)
    if ($Area -gt $BestArea) { $Best = $H; $BestArea = $Area }
  }
  return $Best
}

# The biggest descendant: the webview's own window, which should cover the client area.
function Content-Fit($H) {
  $Client = New-Object W+RECT
  [void][W]::GetClientRect($H, [ref]$Client)
  $Origin = New-Object W+POINT
  [void][W]::ClientToScreen($H, [ref]$Origin)
  $Best = $null
  $BestArea = 0
  foreach ($C in [W]::Children($H)) {
    if (-not [W]::IsWindowVisible($C)) { continue }
    $R = New-Object W+RECT
    [void][W]::GetWindowRect($C, [ref]$R)
    $Area = ($R.Right - $R.Left) * ($R.Bottom - $R.Top)
    if ($Area -gt $BestArea) { $Best = $R; $BestArea = $Area }
  }
  if (-not $Best) { return [ordered]@{ child = $false } }
  $ClientW = $Client.Right - $Client.Left
  $ClientH = $Client.Bottom - $Client.Top
  [ordered]@{
    child = $true
    clientWidth = $ClientW
    clientHeight = $ClientH
    contentWidth = $Best.Right - $Best.Left
    contentHeight = $Best.Bottom - $Best.Top
    contentOffsetX = $Best.Left - $Origin.X
    contentOffsetY = $Best.Top - $Origin.Y
    fits = ([Math]::Abs(($Best.Right - $Best.Left) - $ClientW) -le 2) -and ([Math]::Abs(($Best.Bottom - $Best.Top) - $ClientH) -le 2) -and ([Math]::Abs($Best.Left - $Origin.X) -le 2) -and ([Math]::Abs($Best.Top - $Origin.Y) -le 2)
  }
}

# How long until the webview's window covers the client area again, at most 2 s.
function Wait-Fit($H) {
  $Watch = [System.Diagnostics.Stopwatch]::StartNew()
  while ($Watch.ElapsedMilliseconds -lt 2000) {
    $Fit = Content-Fit $H
    if ($Fit.child -and $Fit.fits) { return [int]$Watch.ElapsedMilliseconds }
    Start-Sleep -Milliseconds 5
  }
  return $null
}

function Shot($Name) {
  if (-not $ScreenshotDir) { return }
  try {
    New-Item -ItemType Directory -Force -Path $ScreenshotDir | Out-Null
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $Bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $Bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height
    $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
    $Graphics.CopyFromScreen($Bounds.Left, $Bounds.Top, 0, 0, $Bitmap.Size)
    $Bitmap.Save((Join-Path $ScreenshotDir "$Name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $Graphics.Dispose(); $Bitmap.Dispose()
  } catch { }
}

function Place($H, $X, $Y, $Width, $Height) {
  [void][W]::ShowWindow($H, 9)
  Start-Sleep -Milliseconds 200
  [void][W]::SetWindowPos($H, [IntPtr]::Zero, $X, $Y, $Width, $Height, 0x0014)
  Start-Sleep -Milliseconds 400
  [void][W]::SetForegroundWindow($H)
  Start-Sleep -Milliseconds 200
}

function Drag($FromX, $FromY, $ToX, $ToY) {
  [void][W]::SetCursorPos($FromX, $FromY)
  Start-Sleep -Milliseconds 150
  [W]::Down()
  Start-Sleep -Milliseconds 80
  $Steps = 12
  for ($I = 1; $I -le $Steps; $I++) {
    [void][W]::SetCursorPos([int]($FromX + ($ToX - $FromX) * $I / $Steps), [int]($FromY + ($ToY - $FromY) * $I / $Steps))
    Start-Sleep -Milliseconds 25
  }
  Start-Sleep -Milliseconds 80
  [W]::Up()
  Start-Sleep -Milliseconds 500
}

$Main = Main-Window
if ($Main -eq [IntPtr]::Zero) {
  @{ error = "no visible window for pids $Pids" } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Out
  exit 0
}

if ($ListOnly) {
  Add-Type -AssemblyName System.Windows.Forms
  $Screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { [ordered]@{ x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height; primary = $_.Primary } })
  $List = @([W]::TopLevel($PidSet) | ForEach-Object {
    $R = [W]::Visible($_)
    [ordered]@{ title = [W]::TitleOf($_); frame = Rect-Object $R; monitor = Rect-Object ([W]::Monitor($_)) }
  })
  [ordered]@{ screens = $Screens; windows = $List } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Out
  exit 0
}

if ($FrameOnly) {
  [ordered]@{
    frame = Rect-Object ([W]::Visible($Main))
    maximized = [W]::IsZoomed($Main)
    windows = @([W]::TopLevel($PidSet)).Count
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $Out
  exit 0
}

$Result = [ordered]@{}
$Result.windowClass = [W]::ClassOf($Main)
$Result.title = [W]::TitleOf($Main)
$Result.dpi = [W]::GetDpiForWindow($Main)
$Result.monitor = Rect-Object ([W]::Monitor($Main))
$Result.workArea = Rect-Object ([W]::Work($Main))
$Result.topLevelWindows = @([W]::TopLevel($PidSet)).Count

$Style = [int64][W]::GetWindowLongPtr($Main, -16)
$ExStyle = [int64][W]::GetWindowLongPtr($Main, -20)
$Result.style = [ordered]@{
  hex = ("0x{0:X8}" -f $Style)
  exHex = ("0x{0:X8}" -f $ExStyle)
  caption = (($Style -band 0x00C00000) -eq 0x00C00000)
  thickFrame = (($Style -band 0x00040000) -ne 0)
  maximizeBox = (($Style -band 0x00010000) -ne 0)
  minimizeBox = (($Style -band 0x00020000) -ne 0)
  sysMenu = (($Style -band 0x00080000) -ne 0)
  popup = (($Style -band 0x80000000) -ne 0)
}

# A known windowed frame to start from, inside the work area on a small screen too.
$Work = [W]::Work($Main)
$Scale = [Math]::Min(1.0, [Math]::Min(($Work.Right - $Work.Left - 260) / 1300.0, ($Work.Bottom - $Work.Top - 180) / 860.0))
function Scaled($Value) { [int][Math]::Round($Value * $Scale) }
$PW = Scaled 1000
$PH = Scaled 680
$Result.probeScale = $Scale
Place $Main ($Work.Left + 100) ($Work.Top + 80) $PW $PH

# The Arm image opens the Start menu at its first sign-in, over every
# window: close whatever covers the window's centre before probing.
function Covering-Class($H) {
  $R = [W]::Visible($H)
  $P = New-Object W+POINT
  $P.X = [int](($R.Left + $R.Right) / 2); $P.Y = [int](($R.Top + $R.Bottom) / 2)
  $Under = [W]::WindowFromPoint($P)
  if ([W]::GetAncestor($Under, 2) -eq $H) { return $null }
  return [W]::ClassOf($Under)
}
$CoveredBy = @()
for ($Try = 0; $Try -lt 5; $Try++) {
  $Over = Covering-Class $Main
  if (-not $Over) { break }
  $CoveredBy += $Over
  [W]::Key(0x1B, $false); [W]::Key(0x1B, $true)
  Get-Process StartMenuExperienceHost, SearchHost, ShellExperienceHost -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
  Place $Main ($Work.Left + 100) ($Work.Top + 80) $PW $PH
}
$Result.coveredBy = $CoveredBy
$Result.stillCovered = [bool](Covering-Class $Main)
$Start = [W]::Visible($Main)
$Result.startFrame = Rect-Object $Start
$Result.startFit = Content-Fit $Main
Shot "01-start"

# What sits at each edge: the window under the point, and its hit code (a
# child that answers HTTRANSPARENT passes the point to the frame).
$MidX = [int](($Start.Left + $Start.Right) / 2)
$MidY = [int](($Start.Top + $Start.Bottom) / 2)
$Points = [ordered]@{
  right = @(($Start.Right + 3), $MidY)
  rightInside = @(($Start.Right - 2), $MidY)
  left = @(($Start.Left - 4), $MidY)
  bottom = @($MidX, ($Start.Bottom + 3))
  bottomInside = @($MidX, ($Start.Bottom - 2))
  top = @($MidX, ($Start.Top + 1))
  bottomRight = @(($Start.Right + 2), ($Start.Bottom + 2))
}
$HitNames = @{ 1 = "client"; 2 = "caption"; 10 = "left"; 11 = "right"; 12 = "top"; 13 = "topLeft"; 14 = "topRight"; 15 = "bottom"; 16 = "bottomLeft"; 17 = "bottomRight"; 0 = "nowhere"; -1 = "transparent"; 18 = "border"; 20 = "close"; 9 = "maxButton"; 8 = "minButton" }
$Hits = [ordered]@{}
foreach ($Name in $Points.Keys) {
  $P = New-Object W+POINT
  $P.X = $Points[$Name][0]; $P.Y = $Points[$Name][1]
  $Under = [W]::WindowFromPoint($P)
  $Root = [W]::GetAncestor($Under, 2)
  $Code = [W]::HitTest($Under, $P.X, $P.Y)
  if ($Code -eq -1 -and $Root -ne $Under) { $Code = [W]::HitTest($Root, $P.X, $P.Y) }
  $Hits[$Name] = [ordered]@{
    x = $P.X; y = $P.Y
    underClass = [W]::ClassOf($Under)
    ownWindow = ($Root -eq $Main)
    code = $Code
    meaning = $(if ($HitNames.ContainsKey($Code)) { $HitNames[$Code] } else { "$Code" })
  }
}
$Result.edgeHitTest = $Hits

# Real drags on the edges.
$Drags = [ordered]@{}
function Try-Drag($Name, $FromX, $FromY, $DX, $DY) {
  Place $Main ($Work.Left + 100) ($Work.Top + 80) $PW $PH
  $Before = [W]::Visible($Main)
  Drag $FromX $FromY ($FromX + $DX) ($FromY + $DY)
  $After = [W]::Visible($Main)
  $FitMs = Wait-Fit $Main
  $Drags[$Name] = [ordered]@{
    from = @($FromX, $FromY)
    by = @($DX, $DY)
    widthChange = ($After.Right - $After.Left) - ($Before.Right - $Before.Left)
    heightChange = ($After.Bottom - $After.Top) - ($Before.Bottom - $Before.Top)
    moved = @(($After.Left - $Before.Left), ($After.Top - $Before.Top))
    contentFitMs = $FitMs
  }
}
Try-Drag "rightEdge" ($Start.Right + 3) $MidY 150 0
Try-Drag "rightEdgeInside" ($Start.Right - 2) $MidY 150 0
Try-Drag "leftEdge" ($Start.Left - 4) $MidY -120 0
Try-Drag "bottomEdge" $MidX ($Start.Bottom + 3) 0 100
Try-Drag "bottomRightCorner" ($Start.Right + 2) ($Start.Bottom + 2) 120 90
Try-Drag "minimumByDrag" ($Start.Right + 3) $MidY -900 0
$Result.edgeDrag = $Drags
Shot "02-after-drags"

# Programmatic resizes: how long until the webview covers the client area.
$Fits = @()
foreach ($Size in @(@(1100, 760), @(900, 600), @(1200, 820), @(820, 560), @(1000, 680), @(1300, 860))) {
  [void][W]::SetWindowPos($Main, [IntPtr]::Zero, ($Work.Left + 100), ($Work.Top + 80), (Scaled $Size[0]), (Scaled $Size[1]), 0x0014)
  $Fits += (Wait-Fit $Main)
}
$Result.resizeContentFitMs = $Fits

# Minimum size, asked for directly.
[void][W]::SetWindowPos($Main, [IntPtr]::Zero, ($Work.Left + 100), ($Work.Top + 80), 300, 200, 0x0014)
Start-Sleep -Milliseconds 50
$Immediate = [W]::Visible($Main)
Start-Sleep -Milliseconds 800
$Later = [W]::Visible($Main)
$Result.minimumSize = [ordered]@{
  asked = @(300, 200)
  immediately = @(($Immediate.Right - $Immediate.Left), ($Immediate.Bottom - $Immediate.Top))
  after800ms = @(($Later.Right - $Later.Left), ($Later.Bottom - $Later.Top))
}

# Maximize with ShowWindow, then with Win+Up.
Place $Main ($Work.Left + 100) ($Work.Top + 80) $PW $PH
[void][W]::ShowWindow($Main, 3)
Start-Sleep -Milliseconds 800
$Max = [W]::Visible($Main)
$Result.maximize = [ordered]@{
  zoomed = [W]::IsZoomed($Main)
  frame = Rect-Object $Max
  matchesWorkArea = ([Math]::Abs($Max.Left - $Work.Left) -le 2) -and ([Math]::Abs($Max.Top - $Work.Top) -le 2) -and ([Math]::Abs($Max.Right - $Work.Right) -le 2) -and ([Math]::Abs($Max.Bottom - $Work.Bottom) -le 2)
  fit = Content-Fit $Main
}
Shot "03-maximized"
[void][W]::ShowWindow($Main, 9)
Start-Sleep -Milliseconds 600
$Restored = [W]::Visible($Main)
$Result.restoreAfterMaximize = Rect-Object $Restored

Place $Main ($Work.Left + 100) ($Work.Top + 80) $PW $PH
[W]::Key(0x5B, $false); [W]::Key(0x26, $false); [W]::Key(0x26, $true); [W]::Key(0x5B, $true)
Start-Sleep -Milliseconds 900
$KeyMax = [W]::Visible($Main)
$Result.maximizeWinUp = [ordered]@{
  foreground = ([W]::GetForegroundWindow() -eq $Main)
  zoomed = [W]::IsZoomed($Main)
  frame = Rect-Object $KeyMax
  matchesWorkArea = ([Math]::Abs($KeyMax.Left - $Work.Left) -le 2) -and ([Math]::Abs($KeyMax.Top - $Work.Top) -le 2) -and ([Math]::Abs($KeyMax.Right - $Work.Right) -le 2) -and ([Math]::Abs($KeyMax.Bottom - $Work.Bottom) -le 2)
}
[void][W]::ShowWindow($Main, 9)
Start-Sleep -Milliseconds 500

# Snap with Win+Left / Win+Right. Escape closes Snap Assist's picker.
function Snap($Name, $Vk, $ExpectLeft) {
  Place $Main ($Work.Left + 100) ($Work.Top + 80) $PW $PH
  [W]::Key(0x5B, $false); [W]::Key($Vk, $false); [W]::Key($Vk, $true); [W]::Key(0x5B, $true)
  Start-Sleep -Milliseconds 1000
  $R = [W]::Visible($Main)
  [W]::Key(0x1B, $false); [W]::Key(0x1B, $true)
  Start-Sleep -Milliseconds 300
  $HalfW = [int](($Work.Right - $Work.Left) / 2)
  $ExpectX = $(if ($ExpectLeft) { $Work.Left } else { $Work.Left + $HalfW })
  $Result[$Name] = [ordered]@{
    frame = Rect-Object $R
    expected = [ordered]@{ x = $ExpectX; y = $Work.Top; width = $HalfW; height = ($Work.Bottom - $Work.Top) }
    snapped = ([Math]::Abs($R.Left - $ExpectX) -le 12) -and ([Math]::Abs(($R.Right - $R.Left) - $HalfW) -le 16) -and ([Math]::Abs($R.Top - $Work.Top) -le 12) -and ([Math]::Abs(($R.Bottom - $R.Top) - ($Work.Bottom - $Work.Top)) -le 16)
    fit = Content-Fit $Main
  }
}
Snap "snapLeft" 0x25 $true
Shot "04-snap-left"
Snap "snapRight" 0x27 $false
Shot "05-snap-right"
[void][W]::ShowWindow($Main, 9)
Start-Sleep -Milliseconds 500

# Minimize and restore.
[void][W]::ShowWindow($Main, 6)
Start-Sleep -Milliseconds 600
$Iconic = [W]::IsIconic($Main)
[void][W]::ShowWindow($Main, 9)
Start-Sleep -Milliseconds 800
$Result.minimizeRestore = [ordered]@{ minimized = $Iconic; restoredVisible = [W]::IsWindowVisible($Main); fitMs = (Wait-Fit $Main) }

# Leave a known frame, close the window, and time the processes out.
Place $Main ($Work.Left + 140) ($Work.Top + 90) (Scaled 1040) (Scaled 700)
Start-Sleep -Milliseconds 1200
$Result.closedAtFrame = Rect-Object ([W]::Visible($Main))
$Watch = [System.Diagnostics.Stopwatch]::StartNew()
[void][W]::PostMessageW($Main, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
$Left = @()
while ($Watch.ElapsedMilliseconds -lt 20000) {
  $Left = @(Get-Process -Id ([int[]]@($PidSet | ForEach-Object { [int]$_ })) -ErrorAction SilentlyContinue)
  if ($Left.Count -eq 0) { break }
  Start-Sleep -Milliseconds 50
}
$Result.close = [ordered]@{
  allExitedMs = $(if ($Left.Count -eq 0) { [int]$Watch.ElapsedMilliseconds } else { $null })
  stillRunning = @($Left | ForEach-Object { $_.ProcessName })
}

$Result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Out
Write-Host ($Result | ConvertTo-Json -Depth 8)

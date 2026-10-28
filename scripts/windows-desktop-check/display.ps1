# Sets the primary display's resolution and scale for the Windows desktop
# check, and prints what it ended up as. The scale changes the way the
# Settings app does (a per-monitor DPI step relative to the recommended one,
# no sign-out), so apps started afterwards draw at it.
#
#   pwsh scripts/windows-desktop-check/display.ps1 [-Width 1920 -Height 1080 | -Largest] [-Scale 125]
#
# -Largest picks the biggest mode up to 2560 wide: the larger the screen, the
# higher the scale Windows allows on it.
param(
  [int]$Width = 0,
  [int]$Height = 0,
  [switch]$Largest,
  [int]$Scale = 0
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class GloomDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion;
    public short dmDriverVersion;
    public short dmSize;
    public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public int dmDisplayOrientation;
    public int dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel;
    public int dmPelsWidth;
    public int dmPelsHeight;
    public int dmDisplayFlags;
    public int dmDisplayFrequency;
    public int dmICMMethod;
    public int dmICMIntent;
    public int dmMediaType;
    public int dmDitherType;
    public int dmReserved1;
    public int dmReserved2;
    public int dmPanningWidth;
    public int dmPanningHeight;
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern bool EnumDisplaySettingsW(string deviceName, int modeNum, ref DEVMODE devMode);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int ChangeDisplaySettingsW(ref DEVMODE devMode, int flags);

  [DllImport("user32.dll")]
  static extern int GetDisplayConfigBufferSizes(uint flags, out uint pathCount, out uint modeCount);

  [DllImport("user32.dll")]
  static extern int QueryDisplayConfig(uint flags, ref uint pathCount, byte[] paths, ref uint modeCount, byte[] modes, IntPtr topology);

  [DllImport("user32.dll")]
  static extern int DisplayConfigGetDeviceInfo(byte[] packet);

  [DllImport("user32.dll")]
  static extern int DisplayConfigSetDeviceInfo(byte[] packet);

  [DllImport("user32.dll")]
  static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  [DllImport("user32.dll")]
  static extern IntPtr MonitorFromPoint(long point, uint flags);

  [DllImport("shcore.dll")]
  static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);

  static readonly int[] Scales = { 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500 };

  static DEVMODE Current() {
    var mode = new DEVMODE();
    mode.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    EnumDisplaySettingsW(null, -1, ref mode);
    return mode;
  }

  public static string Modes() {
    var seen = new SortedSet<string>();
    var mode = new DEVMODE();
    mode.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    for (int index = 0; EnumDisplaySettingsW(null, index, ref mode); index++) {
      seen.Add(mode.dmPelsWidth.ToString("D5") + "x" + mode.dmPelsHeight);
    }
    var names = new List<string>();
    foreach (var name in seen) names.Add(name.TrimStart('0'));
    return string.Join(", ", names);
  }

  public static int[] LargestMode(int maxWidth) {
    var best = new int[] { 0, 0 };
    var mode = new DEVMODE();
    mode.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    for (int index = 0; EnumDisplaySettingsW(null, index, ref mode); index++) {
      if (mode.dmPelsWidth > maxWidth) continue;
      if ((long)mode.dmPelsWidth * mode.dmPelsHeight > (long)best[0] * best[1]) best = new int[] { mode.dmPelsWidth, mode.dmPelsHeight };
    }
    return best;
  }

  public static string Resolution() {
    var mode = Current();
    return mode.dmPelsWidth + "x" + mode.dmPelsHeight;
  }

  public static int SetResolution(int width, int height) {
    var mode = Current();
    mode.dmPelsWidth = width;
    mode.dmPelsHeight = height;
    mode.dmFields = 0x00080000 | 0x00100000;
    return ChangeDisplaySettingsW(ref mode, 1);
  }

  // The first active display path's source: its adapter LUID and id, which
  // the scale packets name.
  static void FirstSource(out uint adapterLow, out int adapterHigh, out uint sourceId) {
    uint pathCount, modeCount;
    int status = GetDisplayConfigBufferSizes(2, out pathCount, out modeCount);
    if (status != 0) throw new Exception("GetDisplayConfigBufferSizes failed: " + status);
    var paths = new byte[pathCount * 72];
    var modes = new byte[modeCount * 64];
    status = QueryDisplayConfig(2, ref pathCount, paths, ref modeCount, modes, IntPtr.Zero);
    if (status != 0 || pathCount == 0) throw new Exception("QueryDisplayConfig failed: " + status);
    adapterLow = BitConverter.ToUInt32(paths, 0);
    adapterHigh = BitConverter.ToInt32(paths, 4);
    sourceId = BitConverter.ToUInt32(paths, 8);
  }

  static byte[] Header(int type, int size, uint adapterLow, int adapterHigh, uint sourceId) {
    var packet = new byte[size];
    BitConverter.GetBytes(type).CopyTo(packet, 0);
    BitConverter.GetBytes(size).CopyTo(packet, 4);
    BitConverter.GetBytes(adapterLow).CopyTo(packet, 8);
    BitConverter.GetBytes(adapterHigh).CopyTo(packet, 12);
    BitConverter.GetBytes(sourceId).CopyTo(packet, 16);
    return packet;
  }

  // Min, current and max scale steps relative to the recommended one.
  public static int[] ScaleSteps() {
    uint low, source; int high;
    FirstSource(out low, out high, out source);
    var packet = Header(-3, 32, low, high, source);
    int status = DisplayConfigGetDeviceInfo(packet);
    if (status != 0) throw new Exception("Reading the display scale failed: " + status);
    return new int[] { BitConverter.ToInt32(packet, 20), BitConverter.ToInt32(packet, 24), BitConverter.ToInt32(packet, 28) };
  }

  public static string ScaleSummary() {
    var steps = ScaleSteps();
    int recommended = Math.Abs(steps[0]);
    Func<int, string> at = (step) => {
      int index = recommended + step;
      return index >= 0 && index < Scales.Length ? Scales[index] + "%" : "?";
    };
    return "recommended " + at(0) + ", now " + at(steps[1]) + ", allowed " + at(steps[0]) + " to " + at(steps[2]);
  }

  public static int SetScale(int percent) {
    int target = Array.IndexOf(Scales, percent);
    if (target < 0) throw new Exception("Not a Windows scale step: " + percent);
    var steps = ScaleSteps();
    int recommended = Math.Abs(steps[0]);
    uint low, source; int high;
    FirstSource(out low, out high, out source);
    var packet = Header(-4, 24, low, high, source);
    BitConverter.GetBytes(target - recommended).CopyTo(packet, 20);
    return DisplayConfigSetDeviceInfo(packet);
  }

  public static uint EffectiveDpi() {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    // MONITOR_DEFAULTTOPRIMARY at (0, 0), MDT_EFFECTIVE_DPI
    IntPtr monitor = MonitorFromPoint(0, 1);
    uint dpiX, dpiY;
    GetDpiForMonitor(monitor, 0, out dpiX, out dpiY);
    return dpiX;
  }
}
"@

Write-Host "Display modes: $([GloomDisplay]::Modes())"
if ($Largest) {
  $Mode = [GloomDisplay]::LargestMode(2560)
  $Width = $Mode[0]
  $Height = $Mode[1]
}
if ($Width -gt 0 -and $Height -gt 0) {
  $Result = [GloomDisplay]::SetResolution($Width, $Height)
  Write-Host "Set resolution ${Width}x${Height}: $Result"
  Start-Sleep -Seconds 2
}
if ($Scale -gt 0) {
  try {
    Write-Host "Scale before: $([GloomDisplay]::ScaleSummary())"
    $Result = [GloomDisplay]::SetScale($Scale)
    Write-Host "Set scale ${Scale}%: $Result"
    Start-Sleep -Seconds 3
  } catch {
    Write-Host "Could not set the scale: $($_.Exception.Message)"
  }
}
$Dpi = [GloomDisplay]::EffectiveDpi()
$Summary = [ordered]@{
  resolution = [GloomDisplay]::Resolution()
  dpi = $Dpi
  scale = [int][Math]::Round($Dpi * 100 / 96)
  scaleSteps = $(try { [GloomDisplay]::ScaleSummary() } catch { $_.Exception.Message })
}
$Summary | ConvertTo-Json -Compress

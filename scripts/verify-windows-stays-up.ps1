# Installs the Windows desktop app from an installer, opens it as its shortcut
# does, and checks that it is still running a while later. Run on Windows on
# Arm, where the x64 app runs under emulation, it catches a release that opens
# a window and then crashes there.
#
# Leaves, under $EvidenceDir: what ran and when (stays-up.txt), screenshots,
# the app's and CEF's logs, Windows' crash reports for the app's programs, and
# a minidump of any that crashed.
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$Label = "app",
  [int]$Seconds = 90,
  # The launcher gives the app's own output (and Bun's crash report) nowhere in
  # a release build; with this it passes it through, here to files.
  [switch]$Console,
  [string]$EvidenceDir = (Join-Path (Get-Location) "artifacts\windows-stays-up")
)

$ErrorActionPreference = "Stop"
$Evidence = Join-Path $EvidenceDir $Label
New-Item -ItemType Directory -Force -Path $Evidence | Out-Null
$Report = Join-Path $Evidence "stays-up.txt"
$Programs = @("launcher.exe", "bun.exe", "bun Helper.exe", "bun Helper (GPU).exe", "bun Helper (Renderer).exe", "bun Helper (Plugin).exe", "bun Helper (Alerts).exe")

function Write-Line {
  param([string]$Text)
  $Line = "[{0:HH:mm:ss.fff}] {1}" -f (Get-Date), $Text
  Write-Host $Line
  Add-Content -LiteralPath $Report -Value $Line
}

function Save-Screen {
  param([string]$Name)
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $Bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $Bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height
    $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)
    $Graphics.CopyFromScreen($Bounds.Left, $Bounds.Top, 0, 0, $Bitmap.Size)
    $Bitmap.Save((Join-Path $Evidence "$Name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $Graphics.Dispose()
    $Bitmap.Dispose()
  } catch {
    Write-Line "no screenshot ${Name}: $($_.Exception.Message)"
  }
}

# The app's processes, by the folder they run from.
function Get-AppProcesses {
  param([string]$Folder)
  @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Folder, [System.StringComparison]::OrdinalIgnoreCase) })
}

function Get-InstallFolder {
  $Keys = @(Get-ChildItem "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath } |
    Where-Object { $_.DisplayName -like "Gloom*" -and $_.InstallLocation })
  if ($Keys.Count -eq 0) { throw "The installer left no uninstall entry for Gloom" }
  # Over an install under an older name both may be listed: take the newest.
  ($Keys | Sort-Object { (Get-Item -LiteralPath (Join-Path $_.InstallLocation "bin\launcher.exe") -ErrorAction SilentlyContinue).LastWriteTime } |
    Select-Object -Last 1).InstallLocation.TrimEnd("\")
}

Write-Line "runner: $([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture) $([System.Environment]::OSVersion.VersionString); installer $Installer"

# Windows Error Reporting keeps a minidump of each crash of the app's programs.
$DumpDir = Join-Path $Evidence "dumps"
New-Item -ItemType Directory -Force -Path $DumpDir | Out-Null
foreach ($Program in $Programs) {
  $Key = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\$Program"
  try {
    New-Item -Force -Path $Key | Out-Null
    Set-ItemProperty -Path $Key -Name DumpFolder -Value $DumpDir -Type ExpandString
    Set-ItemProperty -Path $Key -Name DumpType -Value 1 -Type DWord
    Set-ItemProperty -Path $Key -Name DumpCount -Value 4 -Type DWord
  } catch {
    Write-Line "no minidumps for ${Program}: $($_.Exception.Message)"
  }
}

$Install = Start-Process -FilePath $Installer -Wait -PassThru -ArgumentList @(
  "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/LOG=`"$(Join-Path $Evidence 'install.log')`""
)
if ($Install.ExitCode -ne 0) { throw "The installer failed: $($Install.ExitCode)" }
$Folder = Get-InstallFolder
$Launcher = Join-Path $Folder "bin\launcher.exe"
$Version = try { (Get-Content (Join-Path $Folder "Resources\version.json") -Raw | ConvertFrom-Json).version } catch { "unknown" }
Write-Line "installed $Version in $Folder"

$Started = Get-Date
$Output = Join-Path $Evidence "app-stdout.txt"
$Errors = Join-Path $Evidence "app-stderr.txt"
if ($Console) {
  $env:ELECTROBUN_CONSOLE = "1"
  $LauncherProcess = Start-Process -FilePath $Launcher -WorkingDirectory (Split-Path $Launcher) -PassThru `
    -RedirectStandardOutput $Output -RedirectStandardError $Errors
  Remove-Item Env:ELECTROBUN_CONSOLE
} else {
  $LauncherProcess = Start-Process -FilePath $Launcher -WorkingDirectory (Split-Path $Launcher) -PassThru
}
$null = $LauncherProcess.Handle
Write-Line "opened $Launcher (pid $($LauncherProcess.Id))"

$Seen = @{}
$Gone = @{}
$Shots = @(5, 15, 30, $Seconds)
for ($Second = 1; $Second -le $Seconds; $Second++) {
  Start-Sleep -Seconds 1
  $Running = Get-AppProcesses $Folder
  foreach ($Process in $Running) {
    if (-not $Seen.ContainsKey($Process.ProcessId)) {
      $Seen[$Process.ProcessId] = $Process.Name
      Write-Line ("{0,3} s: {1} started (pid {2}, parent {3})" -f $Second, $Process.Name, $Process.ProcessId, $Process.ParentProcessId)
    }
  }
  foreach ($ProcessId in @($Seen.Keys)) {
    if (-not $Gone.ContainsKey($ProcessId) -and -not ($Running | Where-Object { $_.ProcessId -eq $ProcessId })) {
      $Gone[$ProcessId] = $Second
      $Code = if ($ProcessId -eq $LauncherProcess.Id) { " with $($LauncherProcess.ExitCode)" } else { "" }
      Write-Line ("{0,3} s: {1} exited{2} (pid {3})" -f $Second, $Seen[$ProcessId], $Code, $ProcessId)
    }
  }
  if ($Shots -contains $Second) { Save-Screen ("{0:D3}s" -f $Second) }
}

$Running = Get-AppProcesses $Folder
$Problems = @()
foreach ($Name in @("launcher.exe", "bun.exe")) {
  if (-not ($Running | Where-Object { $_.Name -eq $Name })) {
    $Problems += "$Name is not running $Seconds s after launch"
  }
}

# Windows' own record of what crashed, with the faulting module and offset.
$Crashes = @(Get-WinEvent -FilterHashtable @{ LogName = "Application"; StartTime = $Started } -ErrorAction SilentlyContinue |
  Where-Object { $_.ProviderName -in @("Application Error", "Windows Error Reporting", "Application Hang") })
foreach ($Crash in $Crashes) {
  Write-Line "event $($Crash.Id) $($Crash.ProviderName): $($Crash.Message -replace '\s+', ' ')"
  if ($Crash.ProviderName -eq "Application Error" -and $Crash.Message -match "bun|launcher") {
    $Problems += "Windows reported a crash: $(($Crash.Message -split "`n")[0].Trim())"
  }
}

# The app's logs and CEF's.
Copy-Item -LiteralPath (Join-Path $Folder "bin\app.log") -Destination $Evidence -ErrorAction SilentlyContinue
$LogDir = Join-Path $Evidence "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
foreach ($Root in @($Folder, $env:LOCALAPPDATA, $env:APPDATA, $env:TEMP)) {
  Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction SilentlyContinue -Include "*.log", "*.txt" |
    Where-Object { $_.LastWriteTime -ge $Started -and $_.Length -lt 20MB -and $_.FullName -notlike "$Evidence*" -and ($_.FullName -match "gloom|Gloom|CEF|chrome_debug") } |
    ForEach-Object {
      $Name = ($_.FullName.Substring($Root.Length).TrimStart("\") -replace '[\\/:]', '_')
      Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $LogDir $Name) -ErrorAction SilentlyContinue
    }
}
Get-ChildItem -LiteralPath $DumpDir -File -ErrorAction SilentlyContinue | ForEach-Object { Write-Line "minidump $($_.Name), $($_.Length) bytes" }

# Leave nothing running for the next install.
foreach ($Process in (Get-AppProcesses $Folder)) {
  Stop-Process -Id $Process.ProcessId -Force -ErrorAction SilentlyContinue
}

if ($Problems.Count -gt 0) {
  foreach ($Path in @($Output, $Errors)) {
    if (Test-Path -LiteralPath $Path) {
      Write-Line "last lines of $(Split-Path -Leaf $Path):"
      Get-Content -LiteralPath $Path -Tail 40 | ForEach-Object { Write-Line "  $_" }
    }
  }
  foreach ($Problem in $Problems) { Write-Line "FAIL: $Problem" }
  throw "Gloom $Version did not stay up: $($Problems -join '; ')"
}
Write-Line "Gloom $Version stayed up for $Seconds s"

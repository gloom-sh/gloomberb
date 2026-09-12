$ErrorActionPreference = "Stop"

# Load only the production functions under test; do not run the installer or GUI.
$Tokens = $null
$ParseErrors = $null
$ScriptPath = Join-Path $PSScriptRoot "verify-windows-desktop.ps1"
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors | Out-String) }
foreach ($Name in @("Capture-OnboardingScreenshot", "Restore-EnvironmentVariable", "Save-OnboardingFailureDiagnostics", "New-WindowHandleSet")) {
  $Definition = $Ast.Find({
    param($Node)
    $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq $Name
  }, $false)
  if (-not $Definition) { throw "Missing production function: $Name" }
  Invoke-Expression $Definition.Extent.Text
}

function Assert-Condition {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function New-TestProcess {
  param([int]$ProcessId, [string]$Name)
  $Process = [pscustomobject]@{
    Id = $ProcessId
    ProcessName = $Name
    HasExited = $false
    ExitCode = $null
    EnableRaisingEvents = $false
  }
  $Process | Add-Member ScriptMethod Refresh { $script:Events.Add("refresh-$($this.Id)") }
  $Process | Add-Member ScriptMethod Dispose { $script:Events.Add("dispose-$($this.Id)") }
  return $Process
}

function Get-VisibleWindows {
  param([switch]$IncludeHiddenAndBounds)
  if ($IncludeHiddenAndBounds) {
    Assert-Condition (-not $script:Stopped) "Window evidence was collected after cleanup"
    if ($script:Mode -eq "diagnostics-fail") { throw "Window inventory failed" }
    return [pscustomobject]@{
      Id = 102; Handle = 196988; MainWindowTitle = "Gloomberb"
      IsVisible = $false; Bounds = $null; BoundsError = "Window bounds are invalid"
    }
  }
  return @()
}

function Save-WindowInventory { param([string]$Path) }

function Start-Process {
  param($FilePath, $WorkingDirectory, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru)
  Assert-Condition ($RedirectStandardOutput -ne $RedirectStandardError) "Launch streams must use separate files"
  Assert-Condition ((Split-Path $RedirectStandardOutput) -eq $script:GuiArtifactDir) "stdout must be retained in the artifact directory"
  Assert-Condition ((Split-Path $RedirectStandardError) -eq $script:GuiArtifactDir) "stderr must be retained in the artifact directory"
  "launcher output" | Set-Content $RedirectStandardOutput
  "launcher error" | Set-Content $RedirectStandardError
  return $script:Launcher
}

function Wait-ForNewWindows {
  param($KnownHandles, $MinimumCount, $Label)
  return [pscustomobject]@{ Id = 102; ProcessName = "bun"; Handle = 196988; MainWindowTitle = "Gloomberb" }
}

function Get-Process { [CmdletBinding()] param($Id) return $script:Child }

function Capture-WindowScreenshotByTitle {
  param($Title, $Path, $Label, $InitialDelaySeconds)
  Assert-Condition $script:Child.EnableRaisingEvents "Child process handle must be retained before waiting"
  if ($script:Mode -eq "success") { return [pscustomobject]@{ Id = 102 } }
  if ($script:Mode -eq "exited") {
    $script:Child.HasExited = $true
    $script:Child.ExitCode = 23
  }
  throw "Original onboarding window failure"
}

function Capture-DesktopScreenshot {
  param($Path)
  Assert-Condition (-not $script:Stopped) "Failure screenshot was collected after cleanup"
  if ($script:Mode -eq "diagnostics-fail") { throw "Screenshot failed" }
  "pre-cleanup screenshot" | Set-Content $Path
}

function Stop-ProcessIds {
  param($Ids)
  Assert-Condition ($Ids -contains 101 -and $Ids -contains 102) "Cleanup lost a launched process"
  $script:Stopped = $true
  $script:Events.Add("cleanup")
}

function Stop-Process { [CmdletBinding()] param($Id, [switch]$Force) $script:Launcher.HasExited = $true }

# Exercise the real enumeration callback with a pure Win32 stand-in. No native
# windows are created; ordinary discovery must still omit hidden/untitled rows.
Add-Type @"
using System;
using System.Text;
public static class GloomberbWin32 {
  public delegate bool EnumWindowsProc(IntPtr handle, IntPtr param);
  public static bool EnumWindows(EnumWindowsProc callback, IntPtr param) {
    for (int i = 1; i <= 3; i++) callback(new IntPtr(i), param);
    return true;
  }
  public static bool IsWindowVisible(IntPtr handle) { return handle.ToInt32() != 2; }
  public static bool IsIconic(IntPtr handle) { return handle.ToInt32() == 2; }
  public static int GetWindowTextLength(IntPtr handle) { return handle.ToInt32() == 2 ? 0 : 9; }
  public static int GetWindowText(IntPtr handle, StringBuilder text, int capacity) {
    if (handle.ToInt32() != 2) text.Append("Gloomberb");
    return text.Length;
  }
  public static uint GetWindowThreadProcessId(IntPtr handle, out uint processId) { processId = 102; return 1; }
}
"@

function Test-WindowDiagnosticsInventory {
  $Definition = $Ast.Find({
    param($Node)
    $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq "Get-VisibleWindows"
  }, $false)
  Invoke-Expression $Definition.Extent.Text
  function Get-WindowBounds {
    param($Window)
    if ($Window.Handle -eq 3) { throw "Invalid window dimensions" }
    return [pscustomobject]@{ Left = 0; Top = 0; Width = 800; Height = 600 }
  }
  $script:Child = New-TestProcess 102 "bun"
  $Normal = @(Get-VisibleWindows)
  $Diagnostics = @(Get-VisibleWindows -IncludeHiddenAndBounds)
  Assert-Condition ($Normal.Count -eq 2 -and $Normal.Handle -notcontains 2) "Normal discovery admitted a hidden/titleless window"
  Assert-Condition ($Diagnostics.Count -eq 3) "Diagnostic inventory lost a native window"
  $Hidden = $Diagnostics | Where-Object Handle -eq 2
  Assert-Condition ($Hidden.MainWindowTitle -eq "" -and -not $Hidden.IsVisible -and $Hidden.Bounds.Width -eq 800) "Hidden/titleless window evidence was lost"
  $Invalid = $Diagnostics | Where-Object Handle -eq 3
  Assert-Condition ($Invalid.BoundsError -eq "Invalid window dimensions" -and $null -eq $Invalid.Bounds) "Invalid bounds evidence was lost"
  Write-Host "PASS window diagnostics: normal, hidden/titleless, invalid bounds"
}
Test-WindowDiagnosticsInventory

$TestDir = Join-Path ([System.IO.Path]::GetTempPath()) "gloom-windows-diagnostics-$([Guid]::NewGuid())"
$InitialHome = $env:HOME
$InitialUserProfile = $env:USERPROFILE
$InitialConsole = $env:ELECTROBUN_CONSOLE
try {
  foreach ($Mode in @("success", "exited", "alive", "diagnostics-fail", "write-fail")) {
    $script:Mode = $Mode
    $script:Events = New-Object System.Collections.Generic.List[string]
    $script:Stopped = $false
    $script:Launcher = New-TestProcess 101 "launcher"
    $script:Child = New-TestProcess 102 "bun"
    $script:GuiArtifactDir = Join-Path $TestDir $Mode
    New-Item -ItemType Directory -Force $script:GuiArtifactDir | Out-Null
    if ($Mode -eq "write-fail") {
      New-Item -ItemType Directory (Join-Path $script:GuiArtifactDir "windows-onboarding-failure.json") | Out-Null
    }
    $ObservedFailure = $null
    try {
      Capture-OnboardingScreenshot -InstallDir $TestDir -OutputPath (Join-Path $TestDir "unused.png")
    } catch {
      $ObservedFailure = $_.Exception.Message
    }
    Assert-Condition ($ObservedFailure -eq $(if ($Mode -eq "success") { $null } else { "Original onboarding window failure" })) "Diagnostics changed the verification outcome: $ObservedFailure"
    Assert-Condition $script:Stopped "Failure did not clean up processes"
    Assert-Condition ($script:Events.Contains("dispose-101") -and $script:Events.Contains("dispose-102")) "Retained process handles were not disposed"
    Assert-Condition ($env:HOME -ceq $InitialHome -and $env:USERPROFILE -ceq $InitialUserProfile -and $env:ELECTROBUN_CONSOLE -ceq $InitialConsole) "Failure did not restore the environment"
    if ($Mode -eq "diagnostics-fail") {
      $Evidence = Get-Content (Join-Path $script:GuiArtifactDir "windows-onboarding-failure.json") -Raw | ConvertFrom-Json
      Assert-Condition ($Evidence.WindowInventoryError -eq "Window inventory failed") "Window read failure was lost"
      Assert-Condition ($Evidence.Processes.Count -eq 2) "Window read failure discarded independent process evidence"
    } elseif ($Mode -eq "success") {
      Assert-Condition (-not (Test-Path (Join-Path $script:GuiArtifactDir "windows-onboarding-failure.json"))) "Healthy launch generated failure diagnostics"
    } elseif ($Mode -ne "write-fail") {
      $Evidence = Get-Content (Join-Path $script:GuiArtifactDir "windows-onboarding-failure.json") -Raw | ConvertFrom-Json
      $ChildState = $Evidence.Processes | Where-Object Id -eq 102
      Assert-Condition ($Evidence.Stage -eq "onboarding-failure-before-cleanup") "Incorrect evidence stage"
      Assert-Condition ($ChildState.HasExited -eq ($Mode -eq "exited")) "Incorrect child liveness"
      Assert-Condition ($ChildState.ExitCode -eq $(if ($Mode -eq "exited") { 23 } else { $null })) "Missing or invented child exit code"
      Assert-Condition ($Evidence.Windows[0].BoundsError -eq "Window bounds are invalid") "Bounds failure evidence was lost"
      Assert-Condition (Test-Path (Join-Path $script:GuiArtifactDir "windows-onboarding-failure.png")) "Missing pre-cleanup screenshot"
    }
    Write-Host "PASS onboarding diagnostics: $Mode"
  }
} finally {
  Remove-Item -Path $TestDir -Recurse -Force -ErrorAction SilentlyContinue
}

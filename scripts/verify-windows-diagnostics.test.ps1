$ErrorActionPreference = "Stop"

# Load only the production functions under test; do not run the installer or GUI.
$Tokens = $null
$ParseErrors = $null
$ScriptPath = Join-Path $PSScriptRoot "verify-windows-desktop.ps1"
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($ScriptPath, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors | Out-String) }
foreach ($Name in @("Capture-OnboardingScreenshot", "Restore-EnvironmentVariable", "Save-LaunchFailureDiagnostics", "New-WindowHandleSet", "Add-TrackedWindowProcesses", "Close-TrackedProcessHandles")) {
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

# PowerShell 7.5 distinguishes an absent variable from a present empty value.
# A string-typed restoration argument would coerce the former to the latter.
$RestoreTestName = "GLOOM_DIAGNOSTICS_RESTORE_$([Guid]::NewGuid().ToString('N'))"
try {
  foreach ($ExpectedValue in @($null, "", "original")) {
    Set-Item -Path "Env:$RestoreTestName" -Value "temporary"
    Restore-EnvironmentVariable $RestoreTestName $ExpectedValue
    $Restored = Get-Item -Path "Env:$RestoreTestName" -ErrorAction SilentlyContinue
    if ($null -eq $ExpectedValue) {
      Assert-Condition ($null -eq $Restored) "Restoration created an originally absent variable"
    } else {
      Assert-Condition ($null -ne $Restored -and $Restored.Value -ceq $ExpectedValue) "Restoration changed an existing variable"
    }
  }
} finally {
  Remove-Item -Path "Env:$RestoreTestName" -ErrorAction SilentlyContinue
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
  param($KnownHandles, $MinimumCount, $Label, $OnDiscovered)
  $Window = [pscustomobject]@{ Id = 102; ProcessName = "bun"; Handle = 196988; MainWindowTitle = "Gloomberb" }
  & $OnDiscovered @($Window)
  return $Window
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

# Execute the unchanged production poll loop against a clock/window stand-in.
# A first window disappearing cannot erase its process before a second appears.
function Test-PartialWindowDiscovery {
  $Definition = $Ast.Find({
    param($Node)
    $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq "Wait-ForNewWindows"
  }, $false)
  Invoke-Expression $Definition.Extent.Text
  function Get-Date { return [DateTime]::new(2026, 9, 12).AddMilliseconds($script:PollTime) }
  function Start-Sleep { param($Milliseconds) $script:PollTime += $Milliseconds }
  function Get-VisibleWindows {
    if ($script:PollTime -eq 0 -or $script:DiscoveryRecovers) {
      [pscustomobject]@{ Id = 102; ProcessName = "bun"; Handle = 10; MainWindowTitle = "Gloomberb" }
    } else {
      $script:Child.HasExited = $true
      $script:Child.ExitCode = 23
    }
    if ($script:DiscoveryRecovers -and $script:PollTime -gt 0) {
      [pscustomobject]@{ Id = 102; ProcessName = "bun"; Handle = 11; MainWindowTitle = "Detached Watchlist" }
    }
    [pscustomobject]@{ Id = 999; ProcessName = "existing"; Handle = 9; MainWindowTitle = "Existing window" }
  }
  foreach ($Recovers in @($false, $true)) {
    $script:DiscoveryRecovers = $Recovers
    $script:PollTime = 0
    $script:Child = New-TestProcess 102 "bun"
    $Tracked = New-Object System.Collections.Generic.List[object]
    $Failure = $null
    $Windows = @()
    try {
      $Windows = @(Wait-ForNewWindows -KnownHandles @{ "9" = $true } -MinimumCount 2 -Label "main and detached" `
        -OnDiscovered { param($Rows) Add-TrackedWindowProcesses $Tracked $Rows })
    } catch { $Failure = $_.Exception.Message }
    Assert-Condition ($Tracked.Count -eq 1 -and $Tracked[0].Process.EnableRaisingEvents) "First window's process was not retained exactly once"
    if ($Recovers) {
      Assert-Condition ($null -eq $Failure -and $Windows.Count -eq 2 -and $script:PollTime -eq 500) "Discovery changed the two-window success condition"
    } else {
      Assert-Condition ($Failure -eq "Timed out waiting for main and detached. Expected at least 2 new visible window(s)." -and $script:PollTime -eq 35000) "Discovery changed the window requirement or timeout"
      Assert-Condition ($Tracked[0].Process.HasExited -and $Tracked[0].Process.ExitCode -eq 23) "Disappeared window lost its retained exit evidence"
    }
  }
  Write-Host "PASS partial window discovery: retained exit and two-window recovery"
}

# Run the actual installer/GUI try/catch/finally with external operations mocked.
# Failure is injected before any native window or after both were discovered.
function Test-MainLaunchDiagnostics {
  param([string]$RootTestDir)
  $MainVerification = @($Ast.EndBlock.Statements | Where-Object { $_ -is [System.Management.Automation.Language.TryStatementAst] })
  Assert-Condition ($MainVerification.Count -eq 1) "Could not isolate the main verification lifecycle"
  function Assert-TuiStarts { param($CliPath) }
  function Disable-InstalledDesktopUpdates { param($InstallDir) }
  function Capture-OnboardingScreenshot { param($InstallDir, $OutputPath) }
  function Seed-DesktopConfig { return $null }
  function Start-Process {
    param($FilePath, $WorkingDirectory, $ArgumentList, $RedirectStandardOutput, $RedirectStandardError, [switch]$Wait, [switch]$PassThru)
    if ($Wait) {
      New-Item -ItemType Directory -Force (Join-Path $InstallDir "bin") | Out-Null
      "test CLI" | Set-Content (Join-Path $InstallDir "bin\gloomberb.cmd")
      return [pscustomobject]@{ ExitCode = 0 }
    }
    Assert-Condition ($RedirectStandardOutput -eq (Join-Path $script:GuiArtifactDir "windows-main-stdout.log")) "Main launch stdout was not retained"
    Assert-Condition ($RedirectStandardError -eq (Join-Path $script:GuiArtifactDir "windows-main-stderr.log")) "Main launch stderr was not retained separately"
    "main launcher output" | Set-Content $RedirectStandardOutput
    "main launcher error" | Set-Content $RedirectStandardError
    return $script:Launcher
  }
  function Wait-ForNewWindows {
    param($KnownHandles, $MinimumCount, $Label, $OnDiscovered)
    Assert-Condition ($MinimumCount -eq 2 -and $Label -eq "Gloomberb main and detached windows") "Main verification weakened its window requirement"
    Assert-Condition $script:Launcher.EnableRaisingEvents "Launcher handle was not retained before waiting"
    if ($script:Mode -eq "main-launcher-exit") {
      $script:Launcher.HasExited = $true
      $script:Launcher.ExitCode = 32
      throw "Original main window timeout"
    }
    $Rows = @(
      [pscustomobject]@{ Id = 102; ProcessName = "bun"; Handle = 10; MainWindowTitle = "Gloomberb" },
      [pscustomobject]@{ Id = 102; ProcessName = "bun"; Handle = 11; MainWindowTitle = "Detached Watchlist" }
    )
    & $OnDiscovered $Rows
    Assert-Condition $script:Child.EnableRaisingEvents "App process handle was not retained during discovery"
    if ($script:Mode -eq "main-partial-exit") {
      $script:Child.HasExited = $true
      $script:Child.ExitCode = 23
      throw "Original main window timeout"
    }
    return $Rows
  }
  function Export-WindowIcon { param($Window, $OutputPath, $Label) throw "Original main verification failure" }
  function Stop-ProcessIds {
    param($Ids)
    if ($script:Mode -in @("main-launcher-exit", "main-partial-exit")) {
      Assert-Condition ($Ids.Count -eq 0) "Diagnostics broadened cleanup to processes seen during a failed wait"
    } else {
      Assert-Condition ($Ids -contains 101 -and $Ids -contains 102) "Main cleanup lost successfully discovered processes"
    }
    $script:Stopped = $true
    $script:Events.Add("cleanup")
  }
  function Get-ChildItem { [CmdletBinding()] param($Path, $Filter, [switch]$File) return @() }
  foreach ($Mode in @("main-launcher-exit", "main-partial-exit", "main-later-failure", "diagnostics-fail", "write-fail")) {
    $script:Mode = $Mode
    $script:Events = New-Object System.Collections.Generic.List[string]
    $script:Stopped = $false
    $script:Launcher = New-TestProcess 101 "launcher"
    $script:Child = New-TestProcess 102 "bun"
    $script:GuiArtifactDir = Join-Path $RootTestDir $Mode
    New-Item -ItemType Directory -Force $script:GuiArtifactDir | Out-Null
    if ($Mode -eq "write-fail") {
      New-Item -ItemType Directory (Join-Path $script:GuiArtifactDir "windows-main-failure.json") | Out-Null
    }
    $InstallDir = Join-Path $script:GuiArtifactDir "install"
    $InstallerPath = Join-Path $RootTestDir "unused-installer.exe"
    $InstallLog = Join-Path $RootTestDir "unused-install.log"
    $GuiProcess = $null
    $LaunchedWindowProcessIds = @()
    $SeededDesktopConfig = $null
    $TrackedGuiProcesses = New-Object System.Collections.Generic.List[object]
    $ObservedFailure = $null
    try { Invoke-Expression $MainVerification[0].Extent.Text } catch { $ObservedFailure = $_.Exception.Message }
    $ExpectedFailure = if ($Mode -in @("main-launcher-exit", "main-partial-exit")) { "Original main window timeout" } else { "Original main verification failure" }
    Assert-Condition ($ObservedFailure -eq $ExpectedFailure) "Main diagnostics changed the failure: $ObservedFailure"
    Assert-Condition ($script:Stopped -and $script:Events.Contains("dispose-101")) "Main failure did not clean up and dispose launcher"
    Assert-Condition ($script:Events.IndexOf("refresh-101") -ge 0 -and $script:Events.IndexOf("refresh-101") -lt $script:Events.IndexOf("cleanup")) "Main process evidence was collected after cleanup"
    if ($Mode -ne "main-launcher-exit") {
      Assert-Condition $script:Events.Contains("dispose-102") "Main failure did not dispose app process handle"
    }
    if ($Mode -ne "write-fail") {
      $Evidence = Get-Content (Join-Path $script:GuiArtifactDir "windows-main-failure.json") -Raw | ConvertFrom-Json
      Assert-Condition ($Evidence.Stage -eq "main-and-detached-failure-before-cleanup" -and $Evidence.Failure -eq $ExpectedFailure) "Main evidence lost stage or original failure"
      $ExpectedProcesses = if ($Mode -eq "main-launcher-exit") { 1 } else { 2 }
      Assert-Condition ($Evidence.Processes.Count -eq $ExpectedProcesses) "Main evidence lost or duplicated a tracked process"
      if ($Mode -eq "main-launcher-exit") {
        Assert-Condition ($Evidence.Processes[0].HasExited -and $Evidence.Processes[0].ExitCode -eq 32) "Launcher exit was lost"
      } elseif ($Mode -eq "main-partial-exit") {
        $Child = $Evidence.Processes | Where-Object Id -eq 102
        Assert-Condition ($Child.HasExited -and $Child.ExitCode -eq 23) "Partial discovery exit was lost"
      } elseif ($Mode -eq "diagnostics-fail") {
        Assert-Condition ($Evidence.WindowInventoryError -eq "Window inventory failed") "Window read failure discarded independent process evidence"
      } else {
        Assert-Condition (-not $Evidence.Processes[0].HasExited -and $null -eq $Evidence.Processes[0].ExitCode) "Alive launcher got an invented exit code"
      }
    }
    Write-Host "PASS main diagnostics: $Mode"
  }
}

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
  Test-PartialWindowDiscovery
  Test-MainLaunchDiagnostics $TestDir
} finally {
  Restore-EnvironmentVariable "ELECTROBUN_CONSOLE" $InitialConsole
  Remove-Item -Path $TestDir -Recurse -Force -ErrorAction SilentlyContinue
}

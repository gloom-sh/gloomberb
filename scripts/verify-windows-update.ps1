param(
  # An installer from an earlier release, built with Electrobun 1: the check
  # starts from its install and updates it to this build. Without one it
  # starts from this build's own installer.
  [string]$EarlierInstaller = "",
  # The zig-zstd to unpack and pack the release with: by default the one the
  # build ships, in the copy the installer was made from.
  [string]$Zstd = ""
)

$ErrorActionPreference = "Stop"
$env:GLOOMBERB_NO_TELEMETRY = "1"
$env:DO_NOT_TRACK = "1"

# An installed app updated in the app the way a user updates it: the app
# finds the update in a copy of the release served from this machine,
# downloads it, and the user presses U to restart into it.
#
# 1. From an earlier release's install in the installer's folder
#    (Programs\Gloom), built with Electrobun 1: its updater puts this build
#    in Electrobun's folder, <local app data>\com.vincelwt.gloomberb\stable\app,
#    and opens it there. This build then retires the installer's folder (its
#    uninstaller runs), and the Start menu and Desktop shortcuts, the `gloom`
#    command on PATH and the Apps & features entry all lead to Electrobun's
#    folder.
# 2. From this build to a newer one, in Electrobun's folder, with Electrobun
#    2's own update manager.
# 3. Electrobun's uninstall entry removes the app, its shortcuts and its entry.
#
# It installs and uninstalls, and writes the user's shortcuts, uninstall
# entries and PATH, so it runs only on a CI machine.

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$BuiltManifest = Get-ChildItem -LiteralPath (Join-Path $Root "artifacts") -Filter "stable-win-*-update.json" -ErrorAction SilentlyContinue | Select-Object -First 1
$Platform = if ($BuiltManifest -and $BuiltManifest.Name -match '^stable-(win-(x64|arm64))-update\.json$') { $Matches[1] } else { "win-x64" }
$InstallerPath = Join-Path $Root "artifacts\stable-$Platform-GloomSetup.exe"
$ArchivePath = Join-Path $Root "artifacts\stable-$Platform-Gloom.tar.zst"
$ManifestPath = Join-Path $Root "artifacts\stable-$Platform-update.json"
if (-not $Zstd) { $Zstd = Join-Path $Root "build\stable-$Platform\Gloom-inno-source\Gloom\bin\zig-zstd.exe" }
$EvidenceDir = Join-Path $Root "artifacts\windows-update-verification"
$WorkRoot = Join-Path $env:USERPROFILE ".cache\gloom-smoke\desktop-update\windows-$PID"
# The app's data folder, seeded below: its freeze log and pending crash reports land there.
$DataDir = Join-Path $WorkRoot "data"
$Identifier = "com.vincelwt.gloomberb"
$ChannelRoot = Join-Path $env:LOCALAPPDATA "$Identifier\stable"
$AppDir = Join-Path $ChannelRoot "app"
$EarlierDir = Join-Path $env:LOCALAPPDATA "Programs\Gloom"
$InstallerKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{D7B2304C-840B-4E5F-956A-3D1C66E67B35}_is1"
$ElectrobunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$Identifier.stable"
$StartMenuShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "Gloom.lnk"
$DesktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Gloom.lnk"
# Where the app looks for its config: the shortcuts, and the scheduled tasks
# that reopen it, start it without this script's environment.
$ConfigHome = Join-Path $env:USERPROFILE ".gloomberb"
$Port = 47821
$BaseUrl = "http://127.0.0.1:$Port"
$UpdateHash = "verifyupdate2"

if ($env:GITHUB_ACTIONS -ne "true") {
  Write-Host "Skipping the in-app update of an installed app outside CI."
  exit 0
}

function Get-ProcessesUnder {
  param([string]$Folder)

  @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and $_.Path.StartsWith("$Folder\", [StringComparison]::OrdinalIgnoreCase) } catch { $false }
  })
}

function Stop-ProcessesUnder {
  param([string[]]$Folders)

  foreach ($Folder in $Folders) {
    Get-ProcessesUnder $Folder | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  for ($Attempt = 0; $Attempt -lt 20; $Attempt += 1) {
    if (@($Folders | ForEach-Object { Get-ProcessesUnder $_ }).Count -eq 0) { return }
    Start-Sleep -Milliseconds 500
  }
}

function Get-BuildInfo {
  param([string]$AppFolder)

  $Path = Join-Path $AppFolder "Resources\version.json"
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) } catch { return $null }
}

function Get-BuildHash {
  param([string]$AppFolder)

  $Info = Get-BuildInfo $AppFolder
  if ($Info) { return [string]$Info.hash }
  $null
}

# The release the build asks for updates: the copy served here. And, for a
# build in a release, the build's id.
function Set-BuildSource {
  param([string]$AppFolder, [string]$Hash, [string]$Version = "")

  $Path = Join-Path $AppFolder "Resources\version.json"
  $Info = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  $Info.baseUrl = $BaseUrl
  if ($Hash) { $Info.hash = $Hash }
  if ($Version) { $Info.version = $Version }
  [IO.File]::WriteAllText($Path, ($Info | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding $false))
}

# A release build keeps Chromium's DevTools port closed. This check finds the
# app's page and presses U through that port, so it opens it on the builds it
# runs: Chromium's flags in Resources\build.json name the port.
function Open-DevToolsPort {
  param([string]$AppFolder)

  $Path = Join-Path $AppFolder "Resources\build.json"
  $Build = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  $Flags = [ordered]@{}
  if ($Build.chromiumFlags) {
    foreach ($Flag in $Build.chromiumFlags.PSObject.Properties) {
      if ($Flag.Name -ne "remote-allow-origins") { $Flags[$Flag.Name] = $Flag.Value }
    }
  }
  $Flags["remote-debugging-port"] = "9222"
  $Build | Add-Member -NotePropertyName chromiumFlags -NotePropertyValue ([pscustomobject]$Flags) -Force
  [IO.File]::WriteAllText($Path, ($Build | ConvertTo-Json -Depth 10 -Compress), (New-Object System.Text.UTF8Encoding $false))
  Write-Host "DevTools port open in $AppFolder for this check"
}

function Get-ShortcutTarget {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  (New-Object -ComObject WScript.Shell).CreateShortcut($Path).TargetPath
}

function Get-UserPathEntries {
  @(([string][Environment]::GetEnvironmentVariable("Path", "User")) -split ";" | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim().Trim('"').TrimEnd("\").ToLowerInvariant() })
}

function Wait-Until {
  param([int]$Seconds, [scriptblock]$Condition)

  $Deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $Deadline) {
    if (& $Condition) { return $true }
    Start-Sleep -Seconds 1
  }
  return [bool](& $Condition)
}

# Where every copy of the app is and runs from, and what leads to it, for the
# evidence and for a failure's message.
function Save-InstallState {
  param([string]$Label)

  $State = [ordered]@{
    label = $Label
    runningFrom = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      try { $_.Path -and (($_.Path -like "$env:LOCALAPPDATA\*")) -and ($_.ProcessName -match '^(launcher|bun|bun Helper.*)$') } catch { $false }
    } | ForEach-Object { $_.Path } | Sort-Object -Unique)
    electrobunFolder = [ordered]@{ path = $AppDir; build = (Get-BuildHash $AppDir); electrobun = $(try { (Get-Content -LiteralPath (Join-Path $AppDir "Resources\build.json") -Raw | ConvertFrom-Json).electrobunVersion } catch { $null }) }
    installerFolder = [ordered]@{ path = $EarlierDir; exists = (Test-Path -LiteralPath $EarlierDir); build = (Get-BuildHash $EarlierDir) }
    installerEntry = (Test-Path $InstallerKey)
    electrobunEntry = $(if (Test-Path $ElectrobunKey) { (Get-ItemProperty -Path $ElectrobunKey).QuietUninstallString } else { $null })
    startMenuShortcut = (Get-ShortcutTarget $StartMenuShortcut)
    desktopShortcut = (Get-ShortcutTarget $DesktopShortcut)
    userPath = @(Get-UserPathEntries | Where-Object { $_ -like "*gloom*" })
    channelRoot = @(Get-ChildItem -LiteralPath $ChannelRoot -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  }
  $Json = $State | ConvertTo-Json -Depth 6
  Set-Content -Path (Join-Path $EvidenceDir "$Label.json") -Value $Json -Encoding UTF8
  Write-Host "${Label}:"
  Write-Host $Json
  $State
}

function Receive-CdpMessage {
  param([System.Net.WebSockets.ClientWebSocket]$Socket, [Threading.CancellationToken]$Token)

  $Buffer = [byte[]]::new(65536)
  $Stream = [IO.MemoryStream]::new()
  do {
    $Result = $Socket.ReceiveAsync([ArraySegment[byte]]::new($Buffer), $Token).GetAwaiter().GetResult()
    $Stream.Write($Buffer, 0, $Result.Count)
  } until ($Result.EndOfMessage)
  [Text.Encoding]::UTF8.GetString($Stream.ToArray())
}

# Sends DevTools protocol commands to a page and returns their replies. The
# Windows app's WebView serves the protocol on the first free port from 9222.
function Invoke-Cdp {
  param([string]$Url, [object[]]$Commands)

  $Socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $Timeout = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(15))
  $Replies = New-Object System.Collections.Generic.List[object]
  try {
    $Socket.ConnectAsync([Uri]$Url, $Timeout.Token).GetAwaiter().GetResult()
    $Id = 0
    foreach ($Command in $Commands) {
      $Id += 1
      $Json = [ordered]@{ id = $Id; method = $Command.Method; params = $Command.Params } | ConvertTo-Json -Depth 8 -Compress
      $Bytes = [Text.Encoding]::UTF8.GetBytes($Json)
      $Socket.SendAsync([ArraySegment[byte]]::new($Bytes), [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $Timeout.Token).GetAwaiter().GetResult()
      while ($true) {
        $Reply = Receive-CdpMessage $Socket $Timeout.Token | ConvertFrom-Json
        if ($Reply.id -eq $Id) { $Replies.Add($Reply); break }
      }
    }
  } finally {
    $Socket.Dispose()
    $Timeout.Dispose()
  }
  $Replies.ToArray()
}

function Get-MainPages {
  foreach ($CdpPort in 9222..9232) {
    try {
      $Targets = Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/list" -TimeoutSec 2
    } catch {
      continue
    }
    $Pages = @($Targets | Where-Object { $_.type -eq "page" -and $_.url -like "views://mainview/*" -and $_.webSocketDebuggerUrl })
    if ($Pages.Count -gt 0) { return $Pages }
  }
  @()
}

# U restarts into a downloaded update. The key goes to the page, with nothing
# in it focused that would take it as text; what the page says about the
# update is kept for the evidence.
function Send-RestartKey {
  $Started = Get-Date
  foreach ($Page in Get-MainPages) {
    try {
      $Replies = Invoke-Cdp $Page.webSocketDebuggerUrl @(
        @{ Method = "Runtime.evaluate"; Params = @{
          returnByValue = $true
          expression = "(() => { const active = document.activeElement; if (active && active !== document.body) active.blur(); return (document.body.innerText.match(/[^\n]*(updat|restart|ready|download)[^\n]*/gi) || []).slice(0, 6).join(' | '); })()"
        } },
        @{ Method = "Input.dispatchKeyEvent"; Params = @{ type = "keyDown"; key = "u"; code = "KeyU"; text = "u"; unmodifiedText = "u"; windowsVirtualKeyCode = 85; nativeVirtualKeyCode = 85 } },
        @{ Method = "Input.dispatchKeyEvent"; Params = @{ type = "keyUp"; key = "u"; code = "KeyU"; windowsVirtualKeyCode = 85; nativeVirtualKeyCode = 85 } }
      )
      Write-Host ("Pressed U in {0:N1} s. The page says: {1}" -f ((Get-Date) - $Started).TotalSeconds, $Replies[0].result.result.value)
    } catch {
      Write-Host "Could not press U: $($_.Exception.Message)"
    }
  }
}

# The same through the app's remote control, which a page without a DevTools
# port (WebView2) still has: "update" in the command bar finds Check for
# Updates, which reads "Update ready, restart to apply" once the download is
# in, and activating it restarts. The app writes where it listens into its
# data folder.
function Send-RestartRequest {
  $Endpoint = Join-Path $DataDir "remote-control.desktop.json"
  if (-not (Test-Path -LiteralPath $Endpoint)) { Write-Host "No remote control yet"; return }
  try {
    $Info = Get-Content -LiteralPath $Endpoint -Raw | ConvertFrom-Json
    $Headers = @{ Authorization = "Bearer $($Info.token)" }
    $Url = "http://127.0.0.1:$($Info.port)/rpc"
    $Open = @{ type = "call"; operation = "app.openCommandBar"; input = @{ query = "update" } } | ConvertTo-Json -Depth 5 -Compress
    Invoke-RestMethod -Method Post -Uri $Url -Headers $Headers -ContentType "application/json" -Body $Open -TimeoutSec 10 | Out-Null
    $Activate = @{ type = "call"; operation = "commandBar.activateResult"; input = @{ label = "Update ready, restart to apply" } } | ConvertTo-Json -Depth 5 -Compress
    $Reply = Invoke-RestMethod -Method Post -Uri $Url -Headers $Headers -ContentType "application/json" -Body $Activate -TimeoutSec 10 -SkipHttpErrorCheck
    Write-Host ("Asked for the restart: {0}" -f $(if ($Reply.ok) { "asked" } else { "not yet ($($Reply.error.message))" }))
  } catch {
    # The app quitting for the restart cuts the request off.
    Write-Host "Asked for the restart: $($_.Exception.Message)"
  }
}

# What the page shows, for a failure's message.
function Get-PageText {
  foreach ($Page in Get-MainPages) {
    try {
      $Replies = Invoke-Cdp $Page.webSocketDebuggerUrl @(
        @{ Method = "Runtime.evaluate"; Params = @{ returnByValue = $true; expression = "document.body.innerText.slice(0, 1500)" } }
      )
      return [string]$Replies[0].result.result.value
    } catch {
      return "(could not read the page: $($_.Exception.Message))"
    }
  }
  "(no page)"
}

# Opens what $Shortcut opens, the way the shell does, with the app's console
# output kept for the evidence.
function Open-Shortcut {
  param([string]$Shortcut, [string]$Label)

  $Link = (New-Object -ComObject WScript.Shell).CreateShortcut($Shortcut)
  $PreviousConsole = $env:ELECTROBUN_CONSOLE
  $env:ELECTROBUN_CONSOLE = "1"
  try {
    Start-Process -FilePath $Link.TargetPath -WorkingDirectory $Link.WorkingDirectory `
      -RedirectStandardOutput (Join-Path $EvidenceDir "$Label.out.log") `
      -RedirectStandardError (Join-Path $EvidenceDir "$Label.err.log") | Out-Null
  } finally {
    if ($null -eq $PreviousConsole) { Remove-Item Env:ELECTROBUN_CONSOLE -ErrorAction SilentlyContinue } else { $env:ELECTROBUN_CONSOLE = $PreviousConsole }
  }
}

# Opens the app from $Shortcut until its main page is up from $Folder; a first
# start on a fresh machine can stall before its window.
function Open-App {
  param([string]$Shortcut, [string]$Folder, [string]$Label)

  foreach ($Attempt in 1..2) {
    Remove-Item -LiteralPath (Join-Path $DataDir "remote-control.desktop.json") -Force -ErrorAction SilentlyContinue
    Open-Shortcut $Shortcut "$Label-$Attempt"
    if (Wait-Until 90 { ((Get-ProcessesUnder $Folder).Count -gt 0) -and ((@(Get-MainPages).Count -gt 0) -or (Test-Path -LiteralPath (Join-Path $DataDir "remote-control.desktop.json"))) }) { return }
    Write-Host "The app did not open its window from $Folder. It runs: $((Get-ProcessesUnder $Folder | ForEach-Object { $_.Path }) -join ', ')"
    Stop-ProcessesUnder @($Folder)
  }
  throw "$Shortcut did not open the app from $Folder"
}

# Waits for the app in $Folder to download the build $Hash, then presses U
# until the app that ran before quits for the restart.
function Restart-IntoUpdate {
  param([string]$Folder, [string]$Hash, [string]$Label)

  $Downloaded = Join-Path $ChannelRoot "self-extraction\$Hash.tar"
  if (-not (Wait-Until 300 { Test-Path -LiteralPath $Downloaded })) {
    Save-InstallState "$Label-no-download" | Out-Null
    Write-Host "The release copy was asked for:"
    Get-Content (Join-Path $EvidenceDir "release-server.err.log") -ErrorAction SilentlyContinue | Select-Object -Last 30
    Write-Host "The page shows: $(Get-PageText)"
    throw "${Label}: the app did not download the update into $Downloaded"
  }
  # The restart is seen by the app processes that ran before U all ending.
  # Its WebView helpers come and go on their own, so the quit starts when bun
  # or the launcher ends.
  $BeforeProcesses = @(Get-ProcessesUnder $Folder)
  $Before = @($BeforeProcesses | ForEach-Object { $_.Id })
  $BeforeMain = @($BeforeProcesses | Where-Object { $_.ProcessName -in @("bun", "launcher") } | ForEach-Object { $_.Id })
  if ($BeforeMain.Count -eq 0) { throw "${Label}: neither bun nor the launcher runs from $Folder before U" }
  $Quitting = $false
  for ($Attempt = 0; $Attempt -lt 30 -and -not $Quitting; $Attempt += 1) {
    $Pressed = Get-Date
    Send-RestartKey
    if (-not (Wait-Until 2 { @(Get-Process -Id $BeforeMain -ErrorAction SilentlyContinue).Count -lt $BeforeMain.Count })) { Send-RestartRequest }
    $Quitting = Wait-Until 5 { @(Get-Process -Id $BeforeMain -ErrorAction SilentlyContinue).Count -lt $BeforeMain.Count }
  }
  if (-not $Quitting) { throw "${Label}: U did not restart the app into the downloaded update. The page shows: $(Get-PageText)" }
  if (-not (Wait-Until 90 { @(Get-Process -Id $Before -ErrorAction SilentlyContinue).Count -eq 0 })) {
    throw "${Label}: U started a restart, but the app still runs 90 s later: $((@(Get-Process -Id $Before -ErrorAction SilentlyContinue) | ForEach-Object { "$($_.Id) $($_.Path)" }) -join ', ')"
  }
  Write-Host ("{0}: the app quit {1:N1} s after the last U." -f $Label, ((Get-Date) - $Pressed).TotalSeconds)
}

function Write-SeededConfig {
  $Layout = @{
    dockRoot = @{ kind = "pane"; instanceId = "portfolio-list:main" }
    instances = @(
      @{
        instanceId = "portfolio-list:main"
        paneId = "portfolio-list"
        title = "Main Portfolio"
        params = @{ collectionId = "main" }
        binding = @{ kind = "none" }
      }
    )
    floating = @()
    detached = @()
  }
  New-Item -ItemType Directory -Force -Path $ConfigHome, $DataDir | Out-Null
  @{ dataDir = $DataDir } | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $ConfigHome "config.json") -Encoding UTF8
  @{
    dataDir = $DataDir
    onboardingComplete = $true
    # Plugin restoration has its own tests and must not add network installs here.
    seededPlugins = @((& bun -e 'import { EXTRACTED_PLUGINS } from "./src/plugins/extracted-plugins"; console.log(JSON.stringify(EXTRACTED_PLUGINS.map(plugin => plugin.id)))') | ConvertFrom-Json)
    # The apps this check opens are not people's installs: nothing they run
    # into goes to the crash and usage reports.
    telemetry = @{ crashReports = $false; usage = $false }
    layout = $Layout
    layouts = @(@{ name = "Verification"; layout = $Layout; paneState = @{}; focusedPaneId = "portfolio-list:main" })
    activeLayoutIndex = 0
  } | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $DataDir "config.json") -Encoding UTF8
}

# The next patch release after $Version: the stable channel only takes a
# release newer than the one it runs.
function Get-NewerVersion {
  param([string]$Version)

  if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)') { throw "This build's version, '$Version', is not major.minor.patch" }
  "$($Matches[1]).$($Matches[2]).$([int]$Matches[3] + 1)"
}

# The release as the app reads it: this build, asking this machine for its
# next update, with the DevTools port open; under $Hash and $Version when
# given, a newer build than this one, with a file of its own in it. Electrobun
# 2 installs it only when the archive's version.json names the manifest's
# version and hash.
function Write-Release {
  param([string]$ReleaseDir, [string]$Hash, [string]$Version = "")

  $Unpacked = Join-Path $WorkRoot "release-build"
  Remove-Item -Recurse -Force $Unpacked -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $Unpacked, $ReleaseDir | Out-Null
  $Tar = Join-Path $WorkRoot "release.tar"
  & $Zstd decompress -i $ArchivePath -o $Tar --no-timing
  if ($LASTEXITCODE -ne 0) { throw "zig-zstd could not unpack $ArchivePath" }
  tar -xf $Tar -C $Unpacked
  if ($LASTEXITCODE -ne 0) { throw "tar could not unpack $Tar" }
  Remove-Item -Force $Tar
  $Top = @(Get-ChildItem -LiteralPath $Unpacked -Directory)
  if ($Top.Count -ne 1) { throw "$ArchivePath should hold one folder; it holds $($Top.Name -join ', ')" }
  $Build = $Top[0].FullName

  Set-BuildSource $Build $Hash $Version
  Open-DevToolsPort $Build
  if ($Hash) {
    Set-Content -Path (Join-Path $Build "Resources\verify-added-by-update.txt") -Value "added by the update"
  }

  tar -cf $Tar -C $Unpacked $Top[0].Name
  if ($LASTEXITCODE -ne 0) { throw "tar could not pack $Build" }
  # Level 3: the default, 19, takes minutes on a build this size.
  & $Zstd compress -i $Tar -o (Join-Path $ReleaseDir "stable-$Platform-Gloom.tar.zst") -l 3 --threads max
  if ($LASTEXITCODE -ne 0) { throw "zig-zstd could not pack $Tar" }
  Remove-Item -Force $Tar

  $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  if ($Hash) { $Manifest.hash = $Hash }
  if ($Version) { $Manifest.version = $Version }
  [IO.File]::WriteAllText((Join-Path $ReleaseDir "stable-$Platform-update.json"), ($Manifest | ConvertTo-Json -Depth 8 -Compress), (New-Object System.Text.UTF8Encoding $false))
  [string]$Manifest.hash
}

function Assert-LeadsToElectrobunFolder {
  param([string]$Label, [bool]$Desktop)

  $Launcher = Join-Path $AppDir "bin\launcher.exe"
  $Shortcuts = @($StartMenuShortcut) + $(if ($Desktop) { @($DesktopShortcut) } else { @() })
  # Counted from this build's first processes. On Windows on Arm the
  # retirement ended three minutes later: the app came up slowly, and the
  # script it starts 10 s in took 40 s more to begin.
  $Done = Wait-Until 420 {
    (-not (Test-Path $InstallerKey)) -and (-not (Test-Path -LiteralPath $EarlierDir)) -and (Test-Path $ElectrobunKey) -and
      (@($Shortcuts | Where-Object { (Get-ShortcutTarget $_) -ne $Launcher }).Count -eq 0) -and
      ((Get-UserPathEntries) -contains (Join-Path $AppDir "bin").ToLowerInvariant()) -and
      (-not ((Get-UserPathEntries) -contains (Join-Path $EarlierDir "bin").ToLowerInvariant()))
  }
  $State = Save-InstallState $Label
  $Log = Join-Path $ChannelRoot "installer-folder.log"
  if (Test-Path -LiteralPath $Log) { Copy-Item -LiteralPath $Log -Destination (Join-Path $EvidenceDir "$Label.installer-folder.log") }
  if (-not $Done) {
    Write-Host "The retirement's log:"
    Get-Content -LiteralPath $Log -ErrorAction SilentlyContinue
    throw "${Label}: the installer's folder, entry and PATH entry should be gone, and the shortcuts, PATH and Electrobun's entry should lead to $AppDir. State: $($State | ConvertTo-Json -Depth 4 -Compress)"
  }
}

$Server = $null
$PreviousUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$HadConfigHome = Test-Path $ConfigHome
New-Item -ItemType Directory -Force -Path $WorkRoot, $EvidenceDir | Out-Null

try {
  foreach ($Taken in @($InstallerKey, $ElectrobunKey, $ChannelRoot, $EarlierDir)) {
    if (Test-Path $Taken) { throw "$Taken already exists on this machine; cannot check the update." }
  }
  if ($HadConfigHome) {
    throw "Refusing to overwrite the config in $ConfigHome."
  }
  Write-SeededConfig

  $ReleaseDir = Join-Path $WorkRoot "release"
  New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null
  $Python = (Get-Command python -ErrorAction Stop).Source
  $Server = Start-Process -FilePath $Python -PassThru -NoNewWindow `
    -ArgumentList @("-m", "http.server", "$Port", "--bind", "127.0.0.1", "--directory", "`"$ReleaseDir`"") `
    -RedirectStandardOutput (Join-Path $EvidenceDir "release-server.out.log") `
    -RedirectStandardError (Join-Path $EvidenceDir "release-server.err.log")
  if (-not (Wait-Until 30 { try { (Invoke-WebRequest -Uri "$BaseUrl/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false } })) {
    throw "Nothing is served at $BaseUrl"
  }

  if ($EarlierInstaller) {
    # 1. An earlier release's install, in the installer's folder, updates to this build.
    $Arguments = @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/MERGETASKS=desktopicon", "/LOG=`"$(Join-Path $EvidenceDir "earlier-install.log")`"")
    $Install = Start-Process -FilePath $EarlierInstaller -Wait -PassThru -ArgumentList $Arguments
    if ($Install.ExitCode -ne 0) { throw "The earlier installer failed: $($Install.ExitCode)" }
    if (-not (Test-Path -LiteralPath (Join-Path $EarlierDir "bin\launcher.exe")) -or -not (Test-Path $InstallerKey)) {
      throw "The earlier installer did not install into $EarlierDir"
    }
    $Earlier = Get-BuildInfo $EarlierDir
    Write-Host "Installed the earlier release, $($Earlier.version) ($($Earlier.hash)), into $EarlierDir"
    Set-BuildSource $EarlierDir ""
    Open-DevToolsPort $EarlierDir
    $BridgeHash = Write-Release -ReleaseDir $ReleaseDir -Hash ""
    if ($BridgeHash -eq $Earlier.hash) { throw "The earlier release and this build have the same hash, $BridgeHash" }
    Save-InstallState "earlier" | Out-Null

    Open-App $StartMenuShortcut $EarlierDir "earlier-start"
    Restart-IntoUpdate -Folder $EarlierDir -Hash $BridgeHash -Label "bridge"
    if (-not (Wait-Until 240 { ((Get-ProcessesUnder $AppDir).Count -gt 0) -and ((Get-BuildHash $AppDir) -eq $BridgeHash) })) {
      $State = Save-InstallState "bridge-failed"
      throw "The earlier release's update should open this build ($BridgeHash) from $AppDir; it runs from $($State.runningFrom -join ', ')"
    }
    Assert-LeadsToElectrobunFolder "bridged" $true
    Write-Host "The earlier release updated to this build in $AppDir and its installer's folder is gone."
  } else {
    # 1. This build's installer installs into Electrobun's folder; the first
    #    start writes Electrobun's records.
    $Install = Start-Process -FilePath $InstallerPath -Wait -PassThru -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/LOG=`"$(Join-Path $EvidenceDir "install.log")`"")
    if ($Install.ExitCode -ne 0) { throw "The installer failed: $($Install.ExitCode)" }
    Set-BuildSource $AppDir ""
    Open-DevToolsPort $AppDir
    $null = Write-Release -ReleaseDir $ReleaseDir -Hash ""
    Open-App $StartMenuShortcut $AppDir "first-start"
    Assert-LeadsToElectrobunFolder "installed" $false
  }

  # 2. This build updates to a newer one in place, with Electrobun 2's own
  #    update manager. The release changes under the running app, which
  #    checks again when it opens.
  Stop-ProcessesUnder @($AppDir)
  $UpdateVersion = Get-NewerVersion (Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json).version
  $null = Write-Release -ReleaseDir $ReleaseDir -Hash $UpdateHash -Version $UpdateVersion
  Open-App $StartMenuShortcut $AppDir "update-start"
  Restart-IntoUpdate -Folder $AppDir -Hash $UpdateHash -Label "update"
  $Updated = Wait-Until 240 {
    ((Get-ProcessesUnder $AppDir).Count -gt 0) -and ((Get-BuildHash $AppDir) -eq $UpdateHash) -and
      (Test-Path -LiteralPath (Join-Path $AppDir "Resources\verify-added-by-update.txt")) -and
      (-not (Test-Path -LiteralPath "$AppDir.previous"))
  }
  $State = Save-InstallState "updated"
  if (-not $Updated) {
    throw "The update should open the new build ($UpdateHash) from $AppDir with nothing set aside; it runs from $($State.runningFrom -join ', ') and $AppDir holds $($State.electrobunFolder.build)"
  }
  Write-Host "This build updated itself in place in $AppDir."

  # 3. Electrobun's uninstall entry removes the app, its shortcuts and its entry.
  Stop-ProcessesUnder @($AppDir)
  $Quiet = [string](Get-ItemProperty -Path $ElectrobunKey).QuietUninstallString
  if ($Quiet -notmatch '^"([^"]+)"\s*(.*)$') { throw "Electrobun's entry uninstalls with '$Quiet'" }
  $Uninstall = Start-Process -FilePath $Matches[1] -ArgumentList $Matches[2] -Wait -PassThru
  $Gone = Wait-Until 120 {
    (-not (Test-Path $ElectrobunKey)) -and (-not (Test-Path -LiteralPath $AppDir)) -and
      (-not (Test-Path -LiteralPath $StartMenuShortcut)) -and (-not (Test-Path -LiteralPath $DesktopShortcut))
  }
  $State = Save-InstallState "uninstalled"
  if (-not $Gone) { throw "Uninstalling (exit $($Uninstall.ExitCode)) should remove $AppDir, its entry and its shortcuts" }
  Write-Host "Electrobun's uninstaller removed the app."
} finally {
  Stop-ProcessesUnder @($AppDir, $EarlierDir)
  if ($Server) { Stop-Process -Id $Server.Id -Force -ErrorAction SilentlyContinue }
  Get-ChildItem -Path $ChannelRoot -Filter "*.log" -File -ErrorAction SilentlyContinue | Copy-Item -Destination $EvidenceDir -ErrorAction SilentlyContinue
  foreach ($Key in @($InstallerKey, $ElectrobunKey)) { Remove-Item -Path $Key -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $ChannelRoot, $EarlierDir -ErrorAction SilentlyContinue
  Remove-Item -Force $StartMenuShortcut, $DesktopShortcut -ErrorAction SilentlyContinue
  if (-not $HadConfigHome) { Remove-Item -Recurse -Force $ConfigHome -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $WorkRoot -ErrorAction SilentlyContinue
  [Environment]::SetEnvironmentVariable("Path", $PreviousUserPath, "User")
}

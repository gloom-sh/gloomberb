$ErrorActionPreference = "Stop"

# An install the Windows installer made, updated in the app the way a user
# updates it: the app finds the update in a copy of the release served from
# this machine, downloads it, and the user presses U to restart into it.
# Afterwards the installer's Start menu and Desktop shortcuts must open the
# new build, from the installer's folder, and its uninstall entry must remove
# it with nothing left: no second copy in Electrobun's own app folder. The
# same goes for a build an updater put in that folder under the app's other
# bundle identifier. Files of the user's in the app's folder (one picked can
# be C:\Tools, with a bin of its own) stay through updates and uninstalling.
# On another drive than the updater's folder, a copy that fails partway
# leaves the installed build as it was and the app where it ran, the app
# does not quit for a move while the gloom command runs from the folder, and
# a move cut short is put right by the next one. It
# installs into Programs\Gloom and a folder on another drive, and writes the
# user's shortcuts, uninstall entries and PATH, so it runs only on a CI
# machine.

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$InstallerPath = Join-Path $Root "artifacts\stable-win-x64-GloomSetup.exe"
$ArchivePath = Join-Path $Root "artifacts\stable-win-x64-Gloom.tar.zst"
$ManifestPath = Join-Path $Root "artifacts\stable-win-x64-update.json"
$Zstd = Join-Path $Root "node_modules\electrobun\dist-win-x64\zig-zstd.exe"
$EvidenceDir = Join-Path $Root "artifacts\windows-update-verification"
$WorkRoot = Join-Path $env:USERPROFILE ".cache\gloom-smoke\desktop-update\windows-$PID"
$InstallDir = Join-Path $env:LOCALAPPDATA "Programs\Gloom"
$UninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{D7B2304C-840B-4E5F-956A-3D1C66E67B35}_is1"
$StartMenuShortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "Gloom.lnk"
$DesktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Gloom.lnk"
# Where the app looks for its config: the shortcuts, and the scheduled tasks
# that reopen it, start it without this script's environment.
$ConfigHome = Join-Path $env:USERPROFILE ".gloomberb"
$Port = 47821
$BaseUrl = "http://127.0.0.1:$Port"
$InstalledHash = "verify-installed-build"
$UpdateHash = "verify-update-build"
$OtherIdentifierHash = "verify-other-identifier-build"
# The user's, in the app's folder.
$UserFiles = @("bin\verify-user-tool.cmd", "bin\verify-user\notes.txt", "Resources\verify-user-notes.txt")
$InstallDirs = @($InstallDir)

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

function Get-BuildHash {
  param([string]$AppFolder)

  $Path = Join-Path $AppFolder "Resources\version.json"
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json).hash } catch { return $null }
}

# The build's id, and the release it asks for updates: the copy served here.
function Set-BuildHash {
  param([string]$AppFolder, [string]$Hash)

  $Path = Join-Path $AppFolder "Resources\version.json"
  $Info = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  $Info.hash = $Hash
  $Info.baseUrl = $BaseUrl
  $Info | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Get-ShortcutTarget {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  (New-Object -ComObject WScript.Shell).CreateShortcut($Path).TargetPath
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

# Where every copy of the app is and runs from, for the evidence and for a
# failure's message.
function Save-InstallState {
  param([string]$Label)

  $State = [ordered]@{
    label = $Label
    runningFrom = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      try { $_.Path -and (($_.Path -like "$env:LOCALAPPDATA\*") -or ($_.Path -like "$InstallDir\*")) -and ($_.ProcessName -match '^(launcher|bun|bun Helper.*)$') } catch { $false }
    } | ForEach-Object { $_.Path } | Sort-Object -Unique)
    installerFolder = [ordered]@{ path = $InstallDir; build = (Get-BuildHash $InstallDir) }
    updaterFolders = @($script:UpdaterApps | ForEach-Object { [ordered]@{ path = $_; build = (Get-BuildHash $_) } })
    startMenuShortcut = (Get-ShortcutTarget $StartMenuShortcut)
    desktopShortcut = (Get-ShortcutTarget $DesktopShortcut)
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
      Write-Host "Pressed U. The page says: $($Replies[0].result.result.value)"
    } catch {
      Write-Host "Could not press U: $($_.Exception.Message)"
    }
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

# The app is up once its main page is.
function Wait-AppOpen {
  param([int]$Seconds)

  Wait-Until $Seconds { ((Get-ProcessesUnder $InstallDir).Count -gt 0) -and (@(Get-MainPages).Count -gt 0) }
}

function Write-SeededConfig {
  param([string]$DataDir)

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
    layout = $Layout
    layouts = @(@{ name = "Verification"; layout = $Layout; paneState = @{}; focusedPaneId = "portfolio-list:main" })
    activeLayoutIndex = 0
  } | ConvertTo-Json -Depth 10 | Set-Content -Path (Join-Path $DataDir "config.json") -Encoding UTF8
}

# The release as the app reads it: its manifest, naming a build other than the
# installed one, and that build's archive.
# A release build keeps Chromium's DevTools port closed (its Chromium flags in
# Resources\build.json set remote-debugging-port to -1). This check finds the
# app's page and presses U through that port, so it opens it on the builds it
# runs, as a dev build has it.
function Open-DevToolsPort {
  param([string]$AppFolder)

  $Path = Join-Path $AppFolder "Resources\build.json"
  $Build = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  $Flags = $Build.chromiumFlags
  if (-not $Flags) { return }
  $Flags.PSObject.Properties.Remove("remote-debugging-port")
  $Flags.PSObject.Properties.Remove("remote-allow-origins")
  if (@($Flags.PSObject.Properties).Count -eq 0) { $Build.PSObject.Properties.Remove("chromiumFlags") }
  [IO.File]::WriteAllText($Path, ($Build | ConvertTo-Json -Depth 10 -Compress), (New-Object System.Text.UTF8Encoding $false))
  Write-Host "DevTools port open in $AppFolder for this check"
}

function Write-Release {
  param([string]$ReleaseDir, [string]$Prefix, [string]$AppName)

  $Unpacked = Join-Path $WorkRoot "update-build"
  New-Item -ItemType Directory -Force -Path $Unpacked, $ReleaseDir | Out-Null
  $Tar = Join-Path $WorkRoot "update.tar"
  & $Zstd decompress -i $ArchivePath -o $Tar --no-timing
  if ($LASTEXITCODE -ne 0) { throw "zig-zstd could not unpack $ArchivePath" }
  tar -xf $Tar -C $Unpacked
  if ($LASTEXITCODE -ne 0) { throw "tar could not unpack $Tar" }
  Remove-Item -Force $Tar

  $UpdateApp = Join-Path $Unpacked $AppName
  Set-BuildHash $UpdateApp $UpdateHash
  Open-DevToolsPort $UpdateApp
  # A file the installer never installed: its uninstall entry must remove it too.
  Set-Content -Path (Join-Path $UpdateApp "Resources\verify-added-by-update.txt") -Value "added by the update"
  Set-Content -Path (Join-Path $UpdateApp "bin\verify-added-by-update.txt") -Value "added by the update"

  tar -cf $Tar -C $Unpacked $AppName
  if ($LASTEXITCODE -ne 0) { throw "tar could not pack $UpdateApp" }
  # Level 3: the default, 19, takes minutes on a build this size.
  & $Zstd compress -i $Tar -o (Join-Path $ReleaseDir "$Prefix-$AppName.tar.zst") -l 3 --threads max
  if ($LASTEXITCODE -ne 0) { throw "zig-zstd could not pack $Tar" }
  Remove-Item -Force $Tar

  $Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  $Manifest.hash = $UpdateHash
  $Manifest | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $ReleaseDir "$Prefix-update.json") -Encoding UTF8
  $UpdateApp
}

function Assert-OpensFromInstallerFolder {
  param([string]$Label, [string]$Build, [string]$Gone)

  $Done = Wait-Until 180 {
    ((Get-ProcessesUnder $InstallDir).Count -gt 0) -and
      ((Get-BuildHash $InstallDir) -eq $Build) -and
      (-not (Test-Path -LiteralPath $Gone)) -and
      (@($script:UpdaterApps | ForEach-Object { Get-ProcessesUnder $_ }).Count -eq 0)
  }
  $State = Save-InstallState $Label
  if (-not $Done) {
    $script:UpdaterApps | ForEach-Object { Get-ChildItem -Path (Join-Path (Split-Path -Parent $_) "*.log") -ErrorAction SilentlyContinue } | ForEach-Object {
      Write-Host "--- $($_.FullName)"
      Get-Content -LiteralPath $_.FullName -Tail 40
    }
    throw "${Label}: the new build ($Build) should run from $InstallDir with nothing left in $Gone. It runs from $($State.runningFrom -join ', '); $InstallDir holds build $($State.installerFolder.build), and the Start menu shortcut opens $($State.startMenuShortcut)."
  }
}

function Install-App {
  param([string]$Label, [string]$Folder)

  $Arguments = @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/MERGETASKS=desktopicon", "/LOG=`"$(Join-Path $EvidenceDir "$Label.log")`"")
  if ($Folder) { $Arguments += "/DIR=`"$Folder`"" }
  $Install = Start-Process -FilePath $InstallerPath -Wait -PassThru -ArgumentList $Arguments
  if ($Install.ExitCode -ne 0) {
    throw "The installer failed: $($Install.ExitCode)"
  }
  Open-DevToolsPort $InstallDir
  foreach ($Shortcut in @($StartMenuShortcut, $DesktopShortcut)) {
    if ((Get-ShortcutTarget $Shortcut) -ne (Join-Path $InstallDir "bin\launcher.exe")) {
      throw "The installer's shortcut $Shortcut opens $(Get-ShortcutTarget $Shortcut)"
    }
  }
}

# Runs the installer's uninstaller; done once its entry is gone and $Done holds.
function Uninstall-App {
  param([string]$Label, [scriptblock]$Done)

  Stop-ProcessesUnder @($InstallDir)
  Start-Process -FilePath ((Get-ItemProperty -Path $UninstallKey).UninstallString.Trim('"')) -Wait `
    -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=`"$(Join-Path $EvidenceDir "$Label.log")`"")
  Wait-Until 120 { -not (Test-Path $UninstallKey) -and (& $Done) }
}

function Get-FilesLeft {
  @(Get-ChildItem -LiteralPath $InstallDir -Recurse -Force -File -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName.Substring($InstallDir.Length + 1) } | Sort-Object)
}

# What a move into the installer's folder left there while it ran.
function Get-MoveLeftovers {
  @(Get-ChildItem -LiteralPath $InstallDir -Directory -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like ".gloom-*" } | ForEach-Object { $_.FullName })
}

function Get-MoveLog {
  try { [string](Get-Content -LiteralPath $MoveLog -Raw -ErrorAction Stop) } catch { "" }
}

function Assert-MoveLog {
  param([string]$Label, [string]$Says)

  $Text = Get-MoveLog
  Set-Content -Path (Join-Path $EvidenceDir "$Label.installer-folder.log") -Value $Text -Encoding UTF8
  if (-not $Text.Contains($Says)) {
    throw "${Label}: the move's log should say '$Says'. It says: $Text"
  }
}

# The app keeps its tries at moving a build, ten minutes apart; a step here
# starts over as if they were long past.
function Clear-MoveTries {
  Remove-Item -LiteralPath $MoveTries -Force -ErrorAction SilentlyContinue
}

function Write-UserFiles {
  foreach ($File in $UserFiles) {
    $Path = Join-Path $InstallDir $File
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    Set-Content -LiteralPath $Path -Value "the user's $File"
  }
}

function Assert-UserFilesKept {
  param([string]$Label)

  foreach ($File in $UserFiles) {
    $Path = Join-Path $InstallDir $File
    if (-not (Test-Path -LiteralPath $Path) -or ((Get-Content -LiteralPath $Path -Raw).Trim() -ne "the user's $File")) {
      throw "${Label}: the user's file $Path is gone or changed"
    }
  }
}

function Start-UpdaterCopy {
  Start-Process -FilePath (Join-Path $UpdaterApp "bin\launcher.exe") -WorkingDirectory (Join-Path $UpdaterApp "bin")
}

$Server = $null
$UpdaterShortcut = $null
$UpdaterUninstallKey = $null
$PreviousUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$HadConfigHome = Test-Path $ConfigHome
$script:UpdaterApps = @()
$AppDataFolders = @()
New-Item -ItemType Directory -Force -Path $WorkRoot, $EvidenceDir | Out-Null

try {
  if ((Test-Path $UninstallKey) -or (Test-Path $InstallDir)) {
    throw "An install is already recorded on this machine; cannot check its update."
  }
  if ($HadConfigHome) {
    throw "Refusing to overwrite the config in $ConfigHome."
  }
  Write-SeededConfig (Join-Path $WorkRoot "data")

  Install-App "install"
  Write-UserFiles

  $Info = Get-Content -LiteralPath (Join-Path $InstallDir "Resources\version.json") -Raw | ConvertFrom-Json
  $Identifiers = @((& bun -e 'import { DESKTOP_APP_IDENTIFIERS } from "./src/renderers/electrobun/shared/app-name"; console.log(JSON.stringify(DESKTOP_APP_IDENTIFIERS))') | ConvertFrom-Json)
  if (-not ($Identifiers -contains $Info.identifier)) {
    throw "The installed build's identifier $($Info.identifier) is not one of $($Identifiers -join ', ')"
  }
  # The move's log and its tries, in the app data folder of the identifier
  # this build carries.
  $ScriptIdentifier = (& bun -e 'import { DESKTOP_APP_IDENTIFIER } from "./src/renderers/electrobun/shared/app-name"; console.log(DESKTOP_APP_IDENTIFIER)').Trim()
  $MoveLog = Join-Path $env:LOCALAPPDATA "$ScriptIdentifier\$($Info.channel)\installer-folder.log"
  $MoveTries = Join-Path $env:LOCALAPPDATA "$ScriptIdentifier\$($Info.channel)\installer-folder-tries.json"
  # Electrobun's updater installs into <app data>\<identifier>\<channel>\app.
  $UpdaterApp = Join-Path $env:LOCALAPPDATA "$($Info.identifier)\$($Info.channel)\app"
  $OtherApp = Join-Path $env:LOCALAPPDATA "$(@($Identifiers | Where-Object { $_ -ne $Info.identifier })[0])\$($Info.channel)\app"
  $script:UpdaterApps = @($UpdaterApp, $OtherApp)
  # What Electrobun's own setup makes for its folder: an uninstall entry
  # named after the identifier, and shortcuts.
  $UpdaterUninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$($Info.identifier)"
  $UpdaterShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Gloom updater copy.lnk"
  if (Test-Path $UpdaterUninstallKey) { throw "An uninstall entry for $($Info.identifier) is already recorded" }
  foreach ($Folder in $script:UpdaterApps) {
    if (Test-Path $Folder) { throw "A copy of the app is already in $Folder" }
    $AppData = Split-Path -Parent $Folder
    if (-not (Test-Path $AppData)) { $AppDataFolders += $AppData }
  }

  $ReleaseDir = Join-Path $WorkRoot "release"
  $Prefix = "$($Info.channel)-win-x64"
  $UpdateApp = Write-Release -ReleaseDir $ReleaseDir -Prefix $Prefix -AppName $Info.name
  Set-BuildHash $InstallDir $InstalledHash

  $Python = (Get-Command python -ErrorAction Stop).Source
  $Server = Start-Process -FilePath $Python -PassThru -NoNewWindow `
    -ArgumentList @("-m", "http.server", "$Port", "--bind", "127.0.0.1", "--directory", "`"$ReleaseDir`"") `
    -RedirectStandardOutput (Join-Path $EvidenceDir "release-server.out.log") `
    -RedirectStandardError (Join-Path $EvidenceDir "release-server.err.log")
  $Serving = Wait-Until 30 {
    try { (Invoke-WebRequest -Uri "$BaseUrl/$Prefix-update.json" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { $false }
  }
  if (-not $Serving) { throw "The release copy is not served at $BaseUrl" }

  # 1. Opened from the Start menu, the app finds the update and downloads it;
  #    U restarts into it.
  Save-InstallState "before-update" | Out-Null
  $Stray = @(Get-Process -Name "launcher", "bun", "bun Helper*" -ErrorAction SilentlyContinue)
  if ($Stray.Count -gt 0) {
    Write-Host "Stopping app processes left from earlier steps: $(($Stray | ForEach-Object { "$($_.Id) $($_.Path)" }) -join ', ')"
    $Stray | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
  Open-Shortcut $StartMenuShortcut "first-start"
  if (-not (Wait-AppOpen 90)) {
    # A first start on a fresh machine can stall before its window; once more.
    Write-Host "The app did not open its window from $InstallDir; opening it again. It runs: $((Get-ProcessesUnder $InstallDir | ForEach-Object { $_.Path }) -join ', ')"
    Stop-ProcessesUnder @($InstallDir)
    Open-Shortcut $StartMenuShortcut "second-start"
    if (-not (Wait-AppOpen 90)) {
      throw "The Start menu shortcut did not open the app from $InstallDir"
    }
  }
  $Downloaded = Join-Path $env:LOCALAPPDATA "$($Info.identifier)\$($Info.channel)\self-extraction\$UpdateHash.tar"
  if (-not (Wait-Until 240 { Test-Path $Downloaded })) {
    Save-InstallState "no-download" | Out-Null
    Write-Host "The release copy was asked for:"
    Get-Content (Join-Path $EvidenceDir "release-server.err.log") -ErrorAction SilentlyContinue
    Write-Host "The page shows: $(Get-PageText)"
    throw "The app did not download the update into $Downloaded"
  }
  $Restarted = $false
  for ($Attempt = 0; $Attempt -lt 30 -and -not $Restarted; $Attempt += 1) {
    Send-RestartKey
    $Restarted = Wait-Until 5 { (Get-ProcessesUnder $InstallDir).Count -eq 0 }
  }
  if (-not $Restarted) {
    throw "U did not restart the app into the downloaded update"
  }
  Assert-OpensFromInstallerFolder -Label "after-update" -Build $UpdateHash -Gone $UpdaterApp

  foreach ($Shortcut in @($StartMenuShortcut, $DesktopShortcut)) {
    if ((Get-ShortcutTarget $Shortcut) -ne (Join-Path $InstallDir "bin\launcher.exe")) {
      throw "$Shortcut opens $(Get-ShortcutTarget $Shortcut) after the update"
    }
  }
  $Entry = Get-ItemProperty -Path $UninstallKey
  if (-not $Entry.UninstallString -or -not (Test-Path -LiteralPath ($Entry.UninstallString.Trim('"')))) {
    throw "The uninstall entry runs $($Entry.UninstallString), which is not there after the update"
  }
  if (-not (Wait-Until 60 { (Get-MoveLeftovers).Count -eq 0 })) {
    throw "The update left $((Get-MoveLeftovers) -join ', ')"
  }
  # The user's files in bin and Resources stay, and only the app's beside them are replaced.
  Assert-UserFilesKept "after-update"
  Assert-MoveLog "after-update" "kept 2 file(s) in $InstallDir\bin that are not the app's"
  if (-not (Test-Path -LiteralPath (Join-Path $InstallDir "bin\verify-added-by-update.txt"))) {
    throw "The update's own file is not in $InstallDir\bin"
  }

  # 2. Opened again from the Desktop shortcut, it is the new build, and it stays where it is.
  Stop-ProcessesUnder @($InstallDir)
  Start-Process -FilePath $DesktopShortcut
  if (-not (Wait-Until 60 { (Get-ProcessesUnder $InstallDir).Count -gt 0 })) {
    throw "The Desktop shortcut did not open the app from $InstallDir"
  }
  Start-Sleep -Seconds 15
  $State = Save-InstallState "desktop-shortcut"
  if ((Get-ProcessesUnder $InstallDir).Count -eq 0 -or (Get-BuildHash $InstallDir) -ne $UpdateHash -or (Test-Path $UpdaterApp)) {
    throw "Opened from the Desktop shortcut, the app should keep running the new build from $InstallDir; it runs from $($State.runningFrom -join ', ')"
  }

  # 3. Opened from the installer's folder beside a copy an earlier update
  #    left in the updater's folder, with the shortcut and uninstall entry
  #    Electrobun's own setup makes for it, the app removes the copy and
  #    points the shortcut at its own folder.
  Stop-ProcessesUnder @($InstallDir)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $UpdaterApp) | Out-Null
  Copy-Item -Recurse -Path $UpdateApp -Destination $UpdaterApp
  $Shell = New-Object -ComObject WScript.Shell
  $Link = $Shell.CreateShortcut($UpdaterShortcut)
  $Link.TargetPath = Join-Path $UpdaterApp "bin\launcher.exe"
  $Link.WorkingDirectory = Join-Path $UpdaterApp "bin"
  $Link.Save()
  New-Item -Path $UpdaterUninstallKey -Force | Out-Null
  New-ItemProperty -Path $UpdaterUninstallKey -Name "InstallLocation" -Value $UpdaterApp -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $UpdaterUninstallKey -Name "UninstallString" -Value "cmd.exe /c rmdir /s /q `"$UpdaterApp`"" -PropertyType String -Force | Out-Null
  Start-Process -FilePath $StartMenuShortcut
  $Removed = Wait-Until 120 {
    -not (Test-Path $UpdaterApp) -and -not (Test-Path $UpdaterUninstallKey) -and
      ((Get-ShortcutTarget $UpdaterShortcut) -eq (Join-Path $InstallDir "bin\launcher.exe"))
  }
  $State = Save-InstallState "updater-copy-removed"
  if (-not $Removed) {
    throw "Opened from $InstallDir, the app should remove the copy in $UpdaterApp ($(Test-Path $UpdaterApp)), its uninstall entry ($(Test-Path $UpdaterUninstallKey)) and point $UpdaterShortcut at its own folder (it opens $(Get-ShortcutTarget $UpdaterShortcut))"
  }
  if ((Get-ProcessesUnder $InstallDir).Count -eq 0) {
    throw "The app stopped running from $InstallDir while it removed the copy in $UpdaterApp"
  }
  Remove-Item -Force $UpdaterShortcut

  # 4. A build an updater put in its folder under the app's other identifier
  #    moves into the installer's folder too.
  Stop-ProcessesUnder @($InstallDir)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OtherApp) | Out-Null
  Copy-Item -Recurse -Path $UpdateApp -Destination $OtherApp
  Set-BuildHash $OtherApp $OtherIdentifierHash
  Start-Process -FilePath (Join-Path $OtherApp "bin\launcher.exe") -WorkingDirectory (Join-Path $OtherApp "bin")
  Assert-OpensFromInstallerFolder -Label "other-identifier" -Build $OtherIdentifierHash -Gone $OtherApp
  Assert-UserFilesKept "other-identifier"

  # 5. The uninstall entry removes all of the app, what updates added
  #    included, and leaves the user's files.
  $Expected = @($UserFiles | Sort-Object) -join ", "
  if (-not (Uninstall-App "uninstall" { ((Get-FilesLeft) -join ", ") -eq $Expected })) {
    $Left = Get-FilesLeft
    throw "Uninstalling should leave only the user's files in ${InstallDir}; it left $($Left.Count) file(s): $(($Left | Select-Object -First 20) -join ', ')"
  }
  foreach ($Shortcut in @($StartMenuShortcut, $DesktopShortcut)) {
    if (Test-Path $Shortcut) { throw "Uninstalling left $Shortcut" }
  }
  foreach ($Folder in $script:UpdaterApps) {
    if (Test-Path $Folder) { throw "A copy of the app is left in $Folder" }
  }
  Save-InstallState "after-uninstall" | Out-Null
  Remove-Item -LiteralPath $InstallDir -Recurse -Force
  Write-Host "An installed app updated in place: its shortcuts opened the new build from $InstallDir, and uninstalling removed it and left the user's files."

  # 6. An install on another drive than the updater's folder.
  $UpdaterDrive = Split-Path -Qualifier $env:LOCALAPPDATA
  $OtherDrive = Split-Path -Qualifier "$Root"
  if ($OtherDrive -eq $UpdaterDrive) {
    Write-Host "Skipping the install on another drive: the checkout is on $UpdaterDrive too."
  } else {
    $InstallDir = "$OtherDrive\gloom update check\Gloom"
    $InstallDirs += $InstallDir
    if (Test-Path $InstallDir) { throw "$InstallDir is already there" }
    Install-App "install-other-drive" $InstallDir
    Set-BuildHash $InstallDir $InstalledHash
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $UpdaterApp) | Out-Null
    Copy-Item -Recurse -Path $UpdateApp -Destination $UpdaterApp
    Clear-MoveTries

    # 6a. While the gloom command runs from the installer's folder, the app
    #     does not quit for a move it cannot make, and runs where it is.
    $BusyScript = Join-Path $WorkRoot "busy.js"
    Set-Content -LiteralPath $BusyScript -Value "setTimeout(() => {}, 600000);"
    $Busy = Start-Process -FilePath (Join-Path $InstallDir "bin\bun.exe") -ArgumentList "`"$BusyScript`"" -WindowStyle Hidden -PassThru
    if (-not (Wait-Until 30 { (Get-ProcessesUnder $InstallDir).Count -gt 0 })) { throw "bun did not start from $InstallDir" }
    Start-UpdaterCopy
    $Said = Wait-Until 90 { (Get-MoveLog).Contains(" busy: ") }
    Start-Sleep -Seconds 10
    $State = Save-InstallState "busy"
    Assert-MoveLog "busy" " busy: "
    if (-not $Said -or (Get-ProcessesUnder $UpdaterApp).Count -eq 0 -or (Get-BuildHash $InstallDir) -ne $InstalledHash) {
      throw "With bun running from $InstallDir, the app should keep running from $UpdaterApp and leave $InstallDir as it was. It runs from $($State.runningFrom -join ', '), and $InstallDir holds build $($State.installerFolder.build)."
    }
    Stop-Process -Id $Busy.Id -Force -ErrorAction SilentlyContinue
    Stop-ProcessesUnder @($UpdaterApp, $InstallDir)
    Clear-MoveTries

    # 6b. A copy across drives that fails partway, here on a file it cannot
    #     read (for a user, a full disk): the installed build stays whole,
    #     the app opens again where it ran, and it does not quit to try
    #     again at once.
    $LockedPath = Join-Path $UpdaterApp "bin\verify-locked.bin"
    Set-Content -LiteralPath $LockedPath -Value "locked"
    $Lock = [IO.File]::Open($LockedPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
      Start-UpdaterCopy
      $Reopened = Wait-Until 180 {
        (Get-MoveLog).Contains("opened $UpdaterApp\bin\launcher.exe") -and ((Get-ProcessesUnder $UpdaterApp).Count -gt 0)
      }
      if ($Reopened) { Start-Sleep -Seconds 25 }
      $State = Save-InstallState "copy-failed"
      Assert-MoveLog "copy-failed" "move failed: could not copy the build into $InstallDir"
      $Log = Get-MoveLog
      $Tries = ([regex]::Matches($Log, " started ")).Count
      if (-not $Reopened -or (Get-ProcessesUnder $UpdaterApp).Count -eq 0 -or $Tries -ne 1) {
        throw "After the copy failed, the app should run again from $UpdaterApp without trying again; it runs from $($State.runningFrom -join ', '), and the log shows $Tries tries: $Log"
      }
      if ((Get-BuildHash $InstallDir) -ne $InstalledHash -or -not (Test-Path -LiteralPath (Join-Path $InstallDir "bin\launcher.exe")) -or
        (Test-Path -LiteralPath (Join-Path $InstallDir "bin\bin")) -or (Get-MoveLeftovers).Count -gt 0) {
        throw "After the copy failed, $InstallDir should hold the installed build as it was. It holds build $(Get-BuildHash $InstallDir), and: $((Get-ChildItem -LiteralPath $InstallDir -Force | ForEach-Object { $_.Name }) -join ', '); bin: $((Get-ChildItem -LiteralPath (Join-Path $InstallDir 'bin') -Force -Directory | ForEach-Object { $_.Name }) -join ', ')"
      }
    } finally {
      $Lock.Dispose()
    }
    Stop-ProcessesUnder @($UpdaterApp)
    Remove-Item -LiteralPath $LockedPath -Force
    Clear-MoveTries

    # 6c. A move cut short by a power cut between the two renames of bin left
    #     the folder without it, set aside. The next move puts it back first;
    #     once the copy can be made, the build replaces the app's folders,
    #     which hold nothing else, whole.
    $CutShort = Join-Path $InstallDir ".gloom-previous-20260101000000-cutshort"
    New-Item -ItemType Directory -Path $CutShort | Out-Null
    Move-Item -LiteralPath (Join-Path $InstallDir "bin") -Destination (Join-Path $CutShort "bin")
    Start-UpdaterCopy
    Assert-OpensFromInstallerFolder -Label "other-drive" -Build $UpdateHash -Gone $UpdaterApp
    Assert-MoveLog "other-drive" "put back $InstallDir\bin"
    Assert-MoveLog "other-drive" "replaced $InstallDir\bin"
    if (-not (Wait-Until 60 { (Get-MoveLeftovers).Count -eq 0 })) {
      throw "The move left $((Get-MoveLeftovers) -join ', ')"
    }
    foreach ($Shortcut in @($StartMenuShortcut, $DesktopShortcut)) {
      if ((Get-ShortcutTarget $Shortcut) -ne (Join-Path $InstallDir "bin\launcher.exe")) {
        throw "$Shortcut opens $(Get-ShortcutTarget $Shortcut) after the move"
      }
    }

    # 6d. And uninstalling removes it all.
    if (-not (Uninstall-App "uninstall-other-drive" { -not (Test-Path $InstallDir) })) {
      $Left = Get-FilesLeft
      throw "Uninstalling left $($Left.Count) file(s) in ${InstallDir}: $(($Left | Select-Object -First 20) -join ', ')"
    }
    Save-InstallState "other-drive-uninstalled" | Out-Null
    Write-Host "On another drive, a failed copy left the installed app whole, and the next try moved the update in."
  }
} finally {
  Stop-ProcessesUnder ($InstallDirs + $script:UpdaterApps)
  if ($Server) { Stop-Process -Id $Server.Id -Force -ErrorAction SilentlyContinue }
  foreach ($AppData in @($script:UpdaterApps | ForEach-Object { Split-Path -Parent $_ })) {
    Get-ChildItem -Path $AppData -Filter "*.log" -File -ErrorAction SilentlyContinue |
      Copy-Item -Destination $EvidenceDir -ErrorAction SilentlyContinue
  }
  if (Test-Path $UninstallKey) {
    $Uninstaller = (Get-ItemProperty -Path $UninstallKey).UninstallString
    if ($Uninstaller -and (Test-Path -LiteralPath $Uninstaller.Trim('"'))) {
      Start-Process -FilePath $Uninstaller.Trim('"') -Wait -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART") -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 10
    }
    Remove-Item -Path $UninstallKey -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -Recurse -Force ($InstallDirs + $script:UpdaterApps) -ErrorAction SilentlyContinue
  if ($InstallDirs.Count -gt 1) { Remove-Item -Recurse -Force (Split-Path -Parent $InstallDirs[1]) -ErrorAction SilentlyContinue }
  Remove-Item -Force $StartMenuShortcut, $DesktopShortcut -ErrorAction SilentlyContinue
  if ($UpdaterShortcut) { Remove-Item -Force $UpdaterShortcut -ErrorAction SilentlyContinue }
  if ($UpdaterUninstallKey) { Remove-Item -Path $UpdaterUninstallKey -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $AppDataFolders -ErrorAction SilentlyContinue
  if (-not $HadConfigHome) { Remove-Item -Recurse -Force $ConfigHome -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $WorkRoot -ErrorAction SilentlyContinue
  [Environment]::SetEnvironmentVariable("Path", $PreviousUserPath, "User")
}

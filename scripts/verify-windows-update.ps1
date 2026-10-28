$ErrorActionPreference = "Stop"

# An install the Windows installer made, updated in the app the way a user
# updates it: the app finds the update in a copy of the release served from
# this machine, downloads it, and the user presses U to restart into it.
# Afterwards the installer's Start menu and Desktop shortcuts must open the
# new build, from the installer's folder, and its uninstall entry must remove
# it with nothing left: no second copy in Electrobun's own app folder. The
# same goes for a build an updater put in that folder under the app's other
# bundle identifier. It installs into Programs\Gloom and writes the user's
# shortcuts, uninstall entries and PATH, so it runs only on a CI machine.

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
      try { $_.Path -and ($_.Path -like "$env:LOCALAPPDATA\*") -and ($_.ProcessName -match '^(launcher|bun|bun Helper.*)$') } catch { $false }
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
  # A file the installer never installed: its uninstall entry must remove it too.
  Set-Content -Path (Join-Path $UpdateApp "Resources\verify-added-by-update.txt") -Value "added by the update"

  tar -cf $Tar -C $Unpacked $AppName
  if ($LASTEXITCODE -ne 0) { throw "tar could not pack $UpdateApp" }
  & $Zstd compress -i $Tar -o (Join-Path $ReleaseDir "$Prefix-$AppName.tar.zst")
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

  $InstallLog = Join-Path $EvidenceDir "install.log"
  $Install = Start-Process -FilePath $InstallerPath -Wait -PassThru -ArgumentList @(
    "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CURRENTUSER", "/MERGETASKS=desktopicon", "/LOG=`"$InstallLog`""
  )
  if ($Install.ExitCode -ne 0) {
    throw "The installer failed: $($Install.ExitCode)"
  }
  foreach ($Shortcut in @($StartMenuShortcut, $DesktopShortcut)) {
    if ((Get-ShortcutTarget $Shortcut) -ne (Join-Path $InstallDir "bin\launcher.exe")) {
      throw "The installer's shortcut $Shortcut opens $(Get-ShortcutTarget $Shortcut)"
    }
  }

  $Info = Get-Content -LiteralPath (Join-Path $InstallDir "Resources\version.json") -Raw | ConvertFrom-Json
  $Identifiers = @((& bun -e 'import { DESKTOP_APP_IDENTIFIERS } from "./src/renderers/electrobun/shared/app-name"; console.log(JSON.stringify(DESKTOP_APP_IDENTIFIERS))') | ConvertFrom-Json)
  if (-not ($Identifiers -contains $Info.identifier)) {
    throw "The installed build's identifier $($Info.identifier) is not one of $($Identifiers -join ', ')"
  }
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
  Start-Process -FilePath $StartMenuShortcut
  if (-not (Wait-Until 60 { (Get-ProcessesUnder $InstallDir).Count -gt 0 })) {
    throw "The Start menu shortcut did not open the app from $InstallDir"
  }
  $Downloaded = Join-Path $env:LOCALAPPDATA "$($Info.identifier)\$($Info.channel)\self-extraction\$UpdateHash.tar"
  if (-not (Wait-Until 240 { Test-Path $Downloaded })) {
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
  if (-not (Wait-Until 60 { @(Get-ChildItem -Path "$InstallDir.previous*" -Force -ErrorAction SilentlyContinue).Count -eq 0 })) {
    throw "The update left the old build beside $InstallDir"
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

  # 5. The uninstall entry removes all of it.
  Stop-ProcessesUnder @($InstallDir)
  $UninstallLog = Join-Path $EvidenceDir "uninstall.log"
  Start-Process -FilePath ((Get-ItemProperty -Path $UninstallKey).UninstallString.Trim('"')) -Wait `
    -ArgumentList @("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/LOG=`"$UninstallLog`"")
  if (-not (Wait-Until 120 { -not (Test-Path $UninstallKey) -and -not (Test-Path $InstallDir) })) {
    $Left = @(Get-ChildItem -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
    throw "Uninstalling left $($Left.Count) file(s) in ${InstallDir}: $(($Left | Select-Object -First 20) -join ', ')"
  }
  foreach ($Shortcut in @($StartMenuShortcut, $DesktopShortcut)) {
    if (Test-Path $Shortcut) { throw "Uninstalling left $Shortcut" }
  }
  foreach ($Folder in $script:UpdaterApps) {
    if (Test-Path $Folder) { throw "A copy of the app is left in $Folder" }
  }
  Save-InstallState "after-uninstall" | Out-Null
  Write-Host "An installed app updated in place: its shortcuts opened the new build from $InstallDir, and uninstalling removed it."
} finally {
  Stop-ProcessesUnder (@($InstallDir) + $script:UpdaterApps)
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
  Remove-Item -Recurse -Force (@($InstallDir) + $script:UpdaterApps + @(Get-ChildItem -Path "$InstallDir.previous*" -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })) -ErrorAction SilentlyContinue
  Remove-Item -Force $StartMenuShortcut, $DesktopShortcut -ErrorAction SilentlyContinue
  if ($UpdaterShortcut) { Remove-Item -Force $UpdaterShortcut -ErrorAction SilentlyContinue }
  if ($UpdaterUninstallKey) { Remove-Item -Path $UpdaterUninstallKey -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $AppDataFolders -ErrorAction SilentlyContinue
  if (-not $HadConfigHome) { Remove-Item -Recurse -Force $ConfigHome -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $WorkRoot -ErrorAction SilentlyContinue
  [Environment]::SetEnvironmentVariable("Path", $PreviousUserPath, "User")
}

# Installs the Gloom terminal command on Windows from the latest release:
#
#   irm https://gloom.sh/install.ps1 | iex
#
# It puts gloom.exe in %USERPROFILE%\.local\bin (GLOOM_INSTALL_DIR picks
# another folder) and adds that folder to your PATH. No admin rights needed.
# The desktop app, which includes the command, has its own installer:
# https://gloom.sh/download

function Install-Gloom {
  # Preferences set here stay in this function, not in the shell that ran `iex`.
  $ErrorActionPreference = 'Stop'
  # Windows PowerShell 5.1 downloads many times slower while it draws a progress bar.
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $Repo = 'gloom-sh/gloomberb'
  $Asset = 'gloomberb-windows-x64.exe.gz'
  $InstallDir = if ($env:GLOOM_INSTALL_DIR) { $env:GLOOM_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.local\bin' }
  $InstallDir = $InstallDir.TrimEnd('\')

  # A 32-bit PowerShell on 64-bit Windows reports x86 here and the machine in PROCESSOR_ARCHITEW6432.
  $Arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ($Arch -eq 'ARM64') {
    Write-Host "Windows on Arm: installing the x64 build, which runs through Windows' built-in emulation."
  } elseif ($Arch -ne 'AMD64') {
    throw "Unsupported architecture: $Arch. Gloom needs 64-bit Windows."
  }

  # The asset and its SHA-256, `<asset>.sha256` beside it, both from the latest
  # release's download URL: no API, so no rate limit stands between them.
  $Url = "https://github.com/$Repo/releases/latest/download/$Asset"

  $Temp = Join-Path ([IO.Path]::GetTempPath()) ("gloom-install-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $Temp | Out-Null
  try {
    # Nothing is installed unverified: a checksum that cannot be read, or that does not match, stops here.
    $ChecksumFile = Join-Path $Temp "$Asset.sha256"
    try {
      Invoke-WebRequest -Uri "$Url.sha256" -OutFile $ChecksumFile -UseBasicParsing
    } catch {
      throw "Could not read the SHA-256 checksum for $Asset from $Url.sha256. Nothing was installed. Try again in a minute, or download Gloom from https://gloom.sh/download"
    }
    $Expected = "$(@((Get-Content -Raw -Path $ChecksumFile) -split '\s+' | Where-Object { $_ })[0])".ToLowerInvariant()
    if ($Expected -notmatch '^[0-9a-f]{64}$') { throw "$Url.sha256 holds no SHA-256 checksum. Nothing was installed." }

    $Archive = Join-Path $Temp $Asset
    Write-Host "Downloading $Asset from $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Archive -UseBasicParsing
    $Actual = (Get-FileHash -Path $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne $Expected) { throw "SHA-256 mismatch for $Asset. Nothing was installed." }
    Write-Host "Verified SHA-256 for $Asset."

    Write-Host 'Extracting...'
    $Exe = Join-Path $Temp 'gloom.exe'
    $In = [IO.File]::OpenRead($Archive)
    try {
      $Gzip = New-Object IO.Compression.GZipStream($In, [IO.Compression.CompressionMode]::Decompress)
      $Out = [IO.File]::Create($Exe)
      try { $Gzip.CopyTo($Out) } finally { $Out.Dispose(); $Gzip.Dispose() }
    } finally {
      $In.Dispose()
    }

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $Dest = Join-Path $InstallDir 'gloom.exe'
    try {
      Move-Item -Force -Path $Exe -Destination $Dest
    } catch {
      throw "Could not replace $Dest, which is probably running. Quit gloom, then run this again."
    }
    Write-Host "Installed gloom to $Dest"

    # The user's PATH as written, %VARIABLES% unexpanded, so writing it back keeps them.
    $Environment = (Get-Item -Path 'HKCU:').OpenSubKey('Environment', $true)
    try {
      $Path = [string]$Environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $Listed = @($Path -split ';' | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') })
      if ($Listed -notcontains $InstallDir) {
        $Kind = if ($Path -and $Environment.GetValueNames() -contains 'Path') { $Environment.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        $Environment.SetValue('Path', (@($Path.TrimEnd(';'), $InstallDir) | Where-Object { $_ }) -join ';', $Kind)
        # Tells Explorer, and the terminals it opens next, that the environment changed.
        [Environment]::SetEnvironmentVariable('GLOOM_INSTALL_PATH_CHANGED', '1', 'User')
        [Environment]::SetEnvironmentVariable('GLOOM_INSTALL_PATH_CHANGED', $null, 'User')
        Write-Host "Added $InstallDir to your PATH. Open a new terminal window, then run 'gloom'."
      } else {
        Write-Host "Run 'gloom' to start."
      }
    } finally {
      $Environment.Dispose()
    }
    if (@($env:Path -split ';' | ForEach-Object { $_.TrimEnd('\') }) -notcontains $InstallDir) { $env:Path = "$env:Path;$InstallDir" }
  } finally {
    Remove-Item -Recurse -Force -Path $Temp -ErrorAction SilentlyContinue
  }
}

# Keep the call last: a download cut short must not begin installing.
Install-Gloom

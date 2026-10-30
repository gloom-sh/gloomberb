# Runs install.ps1 as `irm https://gloom.sh/install.ps1 | iex` does, into fresh folders, on the
# latest release's real gloomberb-windows-x64.exe.gz served beside a checksum file this test writes:
# - with its checksum, gloom.exe lands and runs, twice over, and its folder is on the user's PATH once;
# - a checksum file that cannot be read, or that does not match, stops the install, nothing installed.
# The user's PATH is put back afterwards.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Assert-Condition {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

$Asset = 'gloomberb-windows-x64.exe.gz'
$Url = "https://github.com/gloom-sh/gloomberb/releases/latest/download/$Asset"
$Work = Join-Path ([IO.Path]::GetTempPath()) ("gloom-install-test-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Work | Out-Null
$Archive = Join-Path $Work $Asset
Microsoft.PowerShell.Utility\Invoke-WebRequest -Uri $Url -OutFile $Archive -UseBasicParsing
$Hash = (Get-FileHash -Path $Archive -Algorithm SHA256).Hash.ToLowerInvariant()

# What each URL the installer asks for answers: a file, or, when it is not listed, a 404. Defined
# here, this is the Invoke-WebRequest install.ps1 calls.
$Served = @{}
function Invoke-WebRequest {
  param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
  if (-not $Served.ContainsKey($Uri)) { throw "The remote server returned an error: (404) Not Found." }
  Copy-Item -Path $Served[$Uri] -Destination $OutFile
}

# Serves the asset, and $Checksum as its checksum file unless it is empty.
function Set-Release {
  param([AllowNull()][string]$Checksum)
  $Served.Clear()
  $Served[$Url] = $Archive
  if ($Checksum) {
    $File = Join-Path $Work ("checksum-" + [Guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($File, $Checksum)
    $Served["$Url.sha256"] = $File
  }
}

$Environment = (Get-Item -Path 'HKCU:').OpenSubKey('Environment', $true)
$HadPath = $Environment.GetValueNames() -contains 'Path'
$OriginalPath = if ($HadPath) { $Environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
$OriginalKind = if ($HadPath) { $Environment.GetValueKind('Path') } else { $null }
try {
  $Script = Get-Content -Raw -Path (Join-Path $PSScriptRoot 'install.ps1')

  # A checksum that cannot be read, or that does not match, installs nothing.
  $Refusals = @(
    @{ Name = 'missing'; Checksum = $null; Message = 'Could not read the SHA-256 checksum' },
    @{ Name = 'mismatched'; Checksum = ('0' * 64) + "  $Asset`n"; Message = 'SHA-256 mismatch' }
  )
  foreach ($Case in $Refusals) {
    $Dir = Join-Path $Work $Case.Name
    $env:GLOOM_INSTALL_DIR = $Dir
    Set-Release $Case.Checksum
    $Failure = $null
    try { Invoke-Expression $Script } catch { $Failure = $_.Exception.Message }
    Assert-Condition ($null -ne $Failure -and $Failure.Contains($Case.Message)) "A $($Case.Name) checksum should stop with '$($Case.Message)', got: $Failure"
    Assert-Condition ($Failure.Contains('Nothing was installed.')) "A $($Case.Name) checksum should say nothing was installed: $Failure"
    Assert-Condition (-not (Test-Path (Join-Path $Dir 'gloom.exe'))) "A $($Case.Name) checksum installed gloom.exe"
    Write-Host "Refused a $($Case.Name) checksum: $Failure"
  }

  $Dir = Join-Path $Work 'verified'
  $env:GLOOM_INSTALL_DIR = $Dir
  Set-Release "$Hash  $Asset`n"
  Invoke-Expression $Script
  # Run again over the first install: the binary is replaced, and the PATH entry is not added twice.
  Invoke-Expression $Script

  $Exe = Join-Path $Dir 'gloom.exe'
  Assert-Condition (Test-Path $Exe) "install.ps1 did not install $Exe"
  $Output = & $Exe version 2>&1 | Out-String
  Assert-Condition ($LASTEXITCODE -eq 0) "gloom version failed: $Output"
  Write-Host $Output

  $Path = [string]$Environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $Entries = @($Path -split ';' | Where-Object { $_.TrimEnd('\') -eq $Dir })
  Assert-Condition ($Entries.Count -eq 1) "Expected $Dir on the user PATH once, found it $($Entries.Count) times in: $Path"
  # Entries written with %VARIABLES% keep them.
  if ($OriginalPath -and $OriginalPath.Contains('%')) {
    Assert-Condition ($Path.StartsWith($OriginalPath.TrimEnd(';'))) "The user PATH lost its unexpanded entries: $Path"
  }
} finally {
  if ($HadPath) { $Environment.SetValue('Path', $OriginalPath, $OriginalKind) } else { $Environment.DeleteValue('Path', $false) }
  $Environment.Dispose()
  Remove-Item -Recurse -Force -Path $Work -ErrorAction SilentlyContinue
  Remove-Item -Path Env:GLOOM_INSTALL_DIR -ErrorAction SilentlyContinue
}

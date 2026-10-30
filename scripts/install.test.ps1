# Runs install.ps1 as `irm https://gloom.sh/install.ps1 | iex` does, twice, against the latest
# release, into a fresh folder: gloom.exe lands there and runs, and the folder is on the user's
# PATH once. The user's PATH is put back afterwards.
$ErrorActionPreference = 'Stop'

function Assert-Condition {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

$Dir = Join-Path ([IO.Path]::GetTempPath()) ("gloom-install-test-" + [Guid]::NewGuid().ToString('N'))
$Environment = (Get-Item -Path 'HKCU:').OpenSubKey('Environment', $true)
$HadPath = $Environment.GetValueNames() -contains 'Path'
$OriginalPath = if ($HadPath) { $Environment.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
$OriginalKind = if ($HadPath) { $Environment.GetValueKind('Path') } else { $null }
$env:GLOOM_INSTALL_DIR = $Dir
try {
  $Script = Get-Content -Raw -Path (Join-Path $PSScriptRoot 'install.ps1')
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
  Remove-Item -Recurse -Force -Path $Dir -ErrorAction SilentlyContinue
  Remove-Item -Path Env:GLOOM_INSTALL_DIR -ErrorAction SilentlyContinue
}

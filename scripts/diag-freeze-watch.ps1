# Diagnostic only: when the app's heartbeat stops while bun.exe still runs,
# snapshots bun.exe twice, 3 s apart, without attaching a debugger first.
param([string]$Trace, [string]$ProcDump, [string]$Out, [int]$Seconds = 45)

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Log = Join-Path $Out "watch.txt"
$Deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $Deadline) {
  Start-Sleep -Milliseconds 300
  $Bun = Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" | Where-Object { $_.ExecutablePath -like "*\Programs\Gloom\bin\bun.exe" } | Select-Object -First 1
  if (-not $Bun -or -not (Test-Path -LiteralPath $Trace)) { continue }
  $Quiet = ((Get-Date) - (Get-Item -LiteralPath $Trace).LastWriteTime).TotalMilliseconds
  if ($Quiet -lt 2500) { continue }
  Add-Content $Log "$(Get-Date -Format HH:mm:ss.fff) heartbeat quiet for $([int]$Quiet) ms, pid $($Bun.ProcessId); snapshotting"
  & $ProcDump -accepteula -mc 1000 -n 3 -s 2 $Bun.ProcessId $Out 2>&1 | Out-File -Append $Log
  Add-Content $Log "$(Get-Date -Format HH:mm:ss.fff) snapshots done"
  break
}

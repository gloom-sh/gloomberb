# Diagnostic only: when the app's heartbeat stops while bun.exe still runs,
# takes a small snapshot of every thread's stack, then attaches ProcDump to
# write one on the first access violation that follows.
param([string]$Trace, [string]$ProcDump, [string]$Out, [int]$Seconds = 45)

New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Log = Join-Path $Out "watch.txt"
$Deadline = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $Deadline) {
  Start-Sleep -Milliseconds 300
  $Bun = Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" | Where-Object { $_.ExecutablePath -like "*\Programs\Gloom\bin\bun.exe" } | Select-Object -First 1
  if (-not $Bun -or -not (Test-Path -LiteralPath $Trace)) { continue }
  $Quiet = ((Get-Date) - (Get-Item -LiteralPath $Trace).LastWriteTime).TotalMilliseconds
  if ($Quiet -lt 4000) { continue }
  Add-Content $Log "$(Get-Date -Format HH:mm:ss.fff) heartbeat quiet for $([int]$Quiet) ms, pid $($Bun.ProcessId)"
  # Stacks only (MiniDumpWithThreadInfo): small enough to finish before the crash.
  & $ProcDump -accepteula -mc 1000 $Bun.ProcessId (Join-Path $Out "frozen.dmp") 2>&1 | Out-File -Append $Log
  Add-Content $Log "$(Get-Date -Format HH:mm:ss.fff) snapshot done; waiting for an access violation"
  & $ProcDump -accepteula -mc 1000 -e 1 -f C0000005 -n 1 $Bun.ProcessId (Join-Path $Out "crash.dmp") 2>&1 | Out-File -Append $Log
  Add-Content $Log "$(Get-Date -Format HH:mm:ss.fff) done"
  break
}

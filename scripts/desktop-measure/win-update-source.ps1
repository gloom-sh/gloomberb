# Points an installed app's update checks at this machine, where nothing
# answers: measured launches then all check for updates the same way.
param([Parameter(Mandatory = $true)][string]$Folder)

$ErrorActionPreference = "Stop"
$Path = Join-Path $Folder "Resources\version.json"
$Info = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
$Info.baseUrl = "http://127.0.0.1:9"
[IO.File]::WriteAllText($Path, ($Info | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding $false))

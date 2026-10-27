param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$taskProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskNodePath = (Get-Command node -ErrorAction Stop).Source
$taskDataPath = Join-Path $taskProjectRoot 'data'
New-Item -ItemType Directory -Path $taskDataPath -Force | Out-Null
function Test-ConsolePort([int]$Port) {
  $taskClient = [System.Net.Sockets.TcpClient]::new()
  try { $taskClient.Connect('127.0.0.1', $Port); return $true } catch { return $false } finally { $taskClient.Dispose() }
}
if (-not (Test-ConsolePort 4175)) {
  Start-Process -FilePath $taskNodePath -ArgumentList @(('"' + (Join-Path $taskProjectRoot 'server/runner.mjs') + '"')) -WorkingDirectory $taskProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskDataPath 'runner-stdout.log') -RedirectStandardError (Join-Path $taskDataPath 'runner-stderr.log')
}
for ($taskAttempt=0; $taskAttempt -lt 40 -and -not (Test-ConsolePort 4175); $taskAttempt++) { Start-Sleep -Milliseconds 150 }
if (-not (Test-ConsolePort 8787)) {
  Start-Process -FilePath $taskNodePath -ArgumentList @(('"' + (Join-Path $taskProjectRoot 'server/index.mjs') + '"')) -WorkingDirectory $taskProjectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $taskDataPath 'api-stdout.log') -RedirectStandardError (Join-Path $taskDataPath 'api-stderr.log')
}
for ($taskAttempt=0; $taskAttempt -lt 40 -and -not (Test-ConsolePort 8787); $taskAttempt++) { Start-Sleep -Milliseconds 150 }
if (-not (Test-ConsolePort 8787)) { throw 'Console startup failed. See data/api-stderr.log.' }
Write-Output 'Console ready: http://127.0.0.1:8787/app/'
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8787/app/' }

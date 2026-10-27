$ErrorActionPreference='Stop'
$taskProjectRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$taskListener=Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if($taskListener){
  $taskProcess=Get-CimInstance Win32_Process -Filter ('ProcessId='+$taskListener.OwningProcess)
  $taskEntry=(Join-Path $taskProjectRoot 'server/index.mjs').Replace('/','\')
  if($taskProcess.Name -ne 'node.exe' -or -not $taskProcess.CommandLine.Replace('/','\').Contains($taskEntry)){
    throw 'Port 8787 belongs to another application; it was not stopped.'
  }
  Stop-Process -Id $taskProcess.ProcessId
}
& (Join-Path $PSScriptRoot 'start-console.ps1')

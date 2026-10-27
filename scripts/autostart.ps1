param([ValidateSet('Status','Enable','Disable')][string]$Action='Status')
$ErrorActionPreference='Stop'
$taskName='PersonalWorkstationConsole'
$taskProjectRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if($Action -eq 'Enable'){
  $taskCommand='-NoProfile -WindowStyle Hidden -File "'+(Join-Path $PSScriptRoot 'start-console.ps1')+'" -NoBrowser'
  $taskAccount=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $taskAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskCommand -WorkingDirectory $taskProjectRoot
  $taskTrigger=New-ScheduledTaskTrigger -AtLogOn -User $taskAccount
  $taskPrincipal=New-ScheduledTaskPrincipal -UserId $taskAccount -LogonType Interactive -RunLevel Limited
  $taskOptions=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskOptions -Force | Out-Null
}
if($Action -eq 'Disable'){ Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue }
$taskRegistered=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
@{enabled=($null -ne $taskRegistered);mode='current-user-logon'} | ConvertTo-Json -Compress

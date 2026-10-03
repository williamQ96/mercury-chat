$ErrorActionPreference = 'Stop'
$pidFile = Join-Path $PSScriptRoot '.chat.pid'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Output 'No background PID file. For a foreground server use Ctrl+C.'; exit }
$chatProcessId = [int](Get-Content -LiteralPath $pidFile)
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $chatProcessId"
if ($process) {
    $serverFile = Join-Path $PSScriptRoot 'server.mjs'
    if ($process.Name -ne 'node.exe' -or -not $process.CommandLine.Contains($serverFile)) { throw 'PID now belongs to another process; refusing to stop it.' }
    $listeners = Get-NetTCPConnection -OwningProcess $chatProcessId -State Listen -ErrorAction SilentlyContinue
    if ($listeners | Where-Object LocalAddress -ne '127.0.0.1') { throw 'Unexpected listener; refusing to stop it.' }
    $ownedProcess = [System.Diagnostics.Process]::GetProcessById($chatProcessId)
    $ownedProcess.Kill()
    $ownedProcess.WaitForExit(5000) | Out-Null
}
Remove-Item -LiteralPath $pidFile
Write-Output 'Mercury local chat stopped; its in-memory keys were cleared.'

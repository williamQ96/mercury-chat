param([int]$Port = 7860, [switch]$Background)
$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot
$nodePath = (Get-Command node -ErrorAction Stop).Source
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
$portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try { $portProbe.Start() } catch { throw "Port $Port is unavailable. Choose another -Port." } finally { $portProbe.Stop() }
$env:PORT = [string]$Port
if ($Background) {
    $serverFile = Join-Path $appDir 'server.mjs'
    $process = Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverFile + '"') -WorkingDirectory $appDir -WindowStyle Hidden -PassThru
    Start-Sleep -Milliseconds 500
    if ($process.HasExited) { throw 'The local chat process exited during startup.' }
    $process.Id | Set-Content -LiteralPath (Join-Path $appDir '.chat.pid')
    Write-Output "Started PID $($process.Id). Open http://127.0.0.1:$Port"
} else {
    Push-Location -LiteralPath $appDir
    try { & $nodePath 'server.mjs' } finally { Pop-Location }
}

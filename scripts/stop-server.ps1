$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root "server.pid"

if (Test-Path -LiteralPath $pidFile) {
  $pidNumber = 0
  [void][int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$pidNumber)
  if ($pidNumber -le 0) {
    throw "server.pid does not contain a valid PID"
  }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $pidNumber" -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    Remove-Item -LiteralPath $pidFile -Force
    Write-Host "stale server.pid removed (process $pidNumber is not running)"
    exit 0
  }
  $pidTimestamp = (Get-Item -LiteralPath $pidFile).LastWriteTimeUtc
  $processTimestamp = $process.CreationDate.ToUniversalTime()
  $timestampDelta = [Math]::Abs(($pidTimestamp - $processTimestamp).TotalSeconds)
  $hasExpectedCommand =
    $process.CommandLine -match "node_modules[\\/]next[\\/]dist[\\/]bin[\\/]next" -and
    $process.CommandLine -match "\sstart(?:\s|$)"
  $ownsExpectedPort = [bool](
    Get-NetTCPConnection -State Listen -LocalPort 80 -ErrorAction SilentlyContinue |
      Where-Object { $_.OwningProcess -eq $pidNumber }
  )
  $curl = Join-Path $env:SystemRoot "System32\curl.exe"
  $healthPayload = ""
  if ($ownsExpectedPort -and (Test-Path -LiteralPath $curl)) {
    $healthPayload = (& $curl --silent --max-time 3 "http://127.0.0.1/api/health" 2>$null) -join ""
  }
  $hasExpectedHealth =
    $LASTEXITCODE -eq 0 -and
    $healthPayload -match '"ok":true' -and
    $healthPayload -match '"app":"\u955c\u5e8f"'
  $isNextServer =
    $process.Name -ieq "node.exe" -and
    ($hasExpectedCommand -or ($ownsExpectedPort -and $hasExpectedHealth))
  if (-not $isNextServer -or $timestampDelta -gt 60) {
    throw "Refusing to stop PID $pidNumber because it does not match the recorded Next server"
  }
  $taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
  if (-not (Test-Path -LiteralPath $taskkill)) {
    throw "taskkill.exe is unavailable"
  }
  & $taskkill /PID $pidNumber /T /F | Out-Null
  if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $pidNumber -ErrorAction SilentlyContinue)) {
    throw "Server process tree could not be stopped"
  }
  Wait-Process -Id $pidNumber -Timeout 10 -ErrorAction SilentlyContinue
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    if (-not (Get-Process -Id $pidNumber -ErrorAction SilentlyContinue)) {
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process -Id $pidNumber -ErrorAction SilentlyContinue) {
    throw "Server PID $pidNumber did not stop"
  }
  Remove-Item -LiteralPath $pidFile -Force
  Write-Host "server stopped (pid $pidNumber)"
} else {
  Write-Host "server.pid not found, server may not be running"
}

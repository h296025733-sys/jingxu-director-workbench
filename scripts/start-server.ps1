param([int]$Port = 80)

$ErrorActionPreference = "Stop"
# Interactive HTTP work must not inherit Task Scheduler's background priority.
[System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'Normal'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node.exe).Source
$curl = Join-Path $env:SystemRoot "System32\curl.exe"
$pidFile = Join-Path $root "server.pid"
$taskkill = Join-Path $env:SystemRoot "System32\taskkill.exe"
. (Join-Path $PSScriptRoot 'auto-edit-process-policy.ps1')

function Stop-OrphanedAutoEditProcesses {
  if (-not (Test-Path -LiteralPath $taskkill)) { return }
  $labRoot = if ($env:DW_AUTO_EDIT_LAB_ROOT) {
    $env:DW_AUTO_EDIT_LAB_ROOT
  } else {
    (Join-Path (Split-Path -Parent $root) "codex-auto-video-lab")
  }
  $labPattern = [Regex]::Escape($labRoot.TrimEnd("\"))
  $jobPattern = "mx-edit-[1-9][0-9]*-[0-9a-fA-F-]{36}"
  $processSnapshot = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $orphans = $processSnapshot |
    Where-Object {
      $_.ProcessId -ne $PID -and
      $_.CommandLine -and
      $_.CommandLine -match $labPattern -and
      $_.CommandLine -match $jobPattern -and
      (Test-AutoEditProcessOrphan -Candidate $_ -ProcessSnapshot $processSnapshot)
    }
  foreach ($orphan in $orphans) {
    # Recheck identity and parent immediately before termination. An unrelated
    # maintenance/test runner with a live parent is not an abandoned Web job.
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($orphan.ProcessId)" -ErrorAction SilentlyContinue
    if (-not $current -or $current.CreationDate -ne $orphan.CreationDate) { continue }
    $parentSnapshot = @(Get-CimInstance Win32_Process -Filter "ProcessId = $($current.ParentProcessId)" -ErrorAction SilentlyContinue)
    if (-not (Test-AutoEditProcessOrphan -Candidate $current -ProcessSnapshot $parentSnapshot)) { continue }
    & $taskkill /PID $orphan.ProcessId /T /F | Out-Null
  }
}

function Test-LocalServer {
  if (-not (Test-Path -LiteralPath $curl)) { return $false }
  $status = & $curl `
    --silent `
    --output NUL `
    --write-out "%{http_code}" `
    --max-time 3 `
    "http://127.0.0.1:$Port/api/health" 2>$null
  return ($LASTEXITCODE -eq 0 -and ($status -join "").Trim() -eq "200")
}

if (Test-Path -LiteralPath $pidFile) {
  $recordedPid = 0
  [void][int]::TryParse((Get-Content -LiteralPath $pidFile -Raw).Trim(), [ref]$recordedPid)
  if ($recordedPid -gt 0 -and (Get-Process -Id $recordedPid -ErrorAction SilentlyContinue)) {
    throw "A recorded server process is still running (PID $recordedPid). Run stop-server.ps1 first."
  }
  Remove-Item -LiteralPath $pidFile -Force
}

$existingListener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($existingListener) {
  $owners = ($existingListener.OwningProcess | Sort-Object -Unique) -join ","
  throw "Port $Port is already in use by PID(s): $owners"
}

# A hard crash cannot run Node cleanup handlers. Remove only verified AutoLab
# descendants from an earlier mx-edit job before accepting new work.
Stop-OrphanedAutoEditProcesses

# Only the child web process inherits this marker; the launcher's later
# maintenance commands must not accidentally reconcile live tasks.
$previousWebMarker = $env:DW_WEB_SERVICE_PROCESS
try {
  $env:DW_WEB_SERVICE_PROCESS = '1'
  $p = Start-Process `
    -FilePath $node `
    -ArgumentList @("--require", "./scripts/web-runtime-health.cjs", "node_modules\next\dist\bin\next", "start", "-p", $Port, "-H", "0.0.0.0", "--keepAliveTimeout", "125000") `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -PassThru `
    -RedirectStandardOutput (Join-Path $root "server.log") `
    -RedirectStandardError (Join-Path $root "server.err.log")
  $p.PriorityClass = 'Normal'
} finally {
  if ($null -eq $previousWebMarker) { Remove-Item Env:DW_WEB_SERVICE_PROCESS -ErrorAction SilentlyContinue }
  else { $env:DW_WEB_SERVICE_PROCESS = $previousWebMarker }
}

$p.Id | Out-File -FilePath $pidFile -Encoding ascii
Write-Host "server pid: $($p.Id)"

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  $p.Refresh()
  if ($p.HasExited) {
    break
  }
  try {
    $ownedListener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
      Where-Object { $_.OwningProcess -eq $p.Id }
    if ((Test-LocalServer) -and $ownedListener) {
      Write-Host "server ready: http://127.0.0.1:$Port"
      exit 0
    }
  } catch {
    # not ready yet, keep waiting
  }
}

Write-Host "server NOT ready"
if (-not $p.HasExited) {
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
}
if (Test-Path -LiteralPath $pidFile) {
  $pidText = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if ($pidText -eq [string]$p.Id) {
    Remove-Item -LiteralPath $pidFile -Force
  }
}
if (Test-Path (Join-Path $root "server.err.log")) {
  Get-Content (Join-Path $root "server.err.log") -Tail 30
}
exit 1

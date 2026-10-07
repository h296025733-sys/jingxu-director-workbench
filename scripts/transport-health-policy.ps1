# Pure decision function, also exercised by isolated regression tests.
function Get-TunnelHealthAction([bool]$LocalHealthy, [bool]$OriginAlive, [int]$LocalFailures, [int]$PublicFailures) {
  # Rotating a healthy tunnel cannot repair a slow, still-live origin. It also
  # strands open browser tabs on the retired Quick Tunnel hostname.
  if (-not $LocalHealthy) {
    if ($OriginAlive) { return 'keep-origin-busy' }
    if ($LocalFailures -ge 3) { return 'recover-origin' }
    return 'wait'
  }
  if ($PublicFailures -ge 6) { return 'recover-tunnel' }
  return 'wait'
}

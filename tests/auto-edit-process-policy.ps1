$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/auto-edit-process-policy.ps1')
function Assert-Policy($expected,$candidate,$snapshot,$label) {
  if ((Test-AutoEditProcessOrphan -Candidate $candidate -ProcessSnapshot $snapshot) -ne $expected) { throw $label }
}
$birth=[datetime]'2026-09-23T10:00:00Z'
$child=[pscustomobject]@{ProcessId=200;ParentProcessId=100;CreationDate=$birth}
$liveParent=[pscustomobject]@{ProcessId=100;ParentProcessId=50;CreationDate=$birth.AddMinutes(-1)}
Assert-Policy $false $child @($liveParent) 'Must preserve a live independent verification process'
Assert-Policy $true $child @() 'Missing parent is an orphan'
Assert-Policy $true $child @([pscustomobject]@{ProcessId=100;CreationDate=$birth.AddMinutes(1)}) 'Reused parent PID is not ownership'
Assert-Policy $false $child @([pscustomobject]@{ProcessId=100;CreationDate=$null}) 'Unknown parent identity must be preserved'
Assert-Policy $false ([pscustomobject]@{ProcessId=200;ParentProcessId=100;CreationDate=$null}) @() 'Unknown child identity must be preserved'
Assert-Policy $false ([pscustomobject]@{ProcessId=200;ParentProcessId=0;CreationDate=$birth}) @() 'Unknown parent must be preserved'
$tokens=$null;$parseErrors=$null
[void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../scripts/start-server.ps1'),[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
# Exercise the actual CIM representation too, without terminating anything.
$self=Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
$parent=Get-CimInstance Win32_Process -Filter "ProcessId = $($self.ParentProcessId)"
Assert-Policy $false $self @($parent) 'Actual active PowerShell must not be an orphan'
Write-Output '6 isolated policy cases, actual read-only CIM parent check, and launcher syntax passed; no processes terminated or server restarted.'

# Read-only policy: matching a job command does not make a process an orphan.
function Test-AutoEditProcessOrphan {
  param($Candidate, [object[]]$ProcessSnapshot)
  if (-not $Candidate -or -not $Candidate.CreationDate -or [int]$Candidate.ParentProcessId -le 0) { return $false }
  $ancestor = $ProcessSnapshot | Where-Object { [int]$_.ProcessId -eq [int]$Candidate.ParentProcessId } | Select-Object -First 1
  if (-not $ancestor) { return $true }
  if (-not $ancestor.CreationDate) { return $false }
  # A later creation date means Windows reused a dead parent's PID.
  return ([datetime]$ancestor.CreationDate -gt [datetime]$Candidate.CreationDate)
}

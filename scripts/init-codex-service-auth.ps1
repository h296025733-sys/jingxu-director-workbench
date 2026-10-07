$ErrorActionPreference = "Stop"
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$dataRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot "data"))
$codexHome = [System.IO.Path]::GetFullPath((Join-Path $dataRoot "codex-home"))
$expectedPrefix = $dataRoot.TrimEnd('\') + "\"
if (-not $codexHome.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to initialize Codex auth outside the project data directory."
}
$mutex = [System.Threading.Mutex]::new($false, "Local\DirectorWorkbenchCodexAuth")
$mutexAcquired = $false
try {
  $mutexAcquired = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
  $mutexAcquired = $true
}
if (-not $mutexAcquired) {
  $mutex.Dispose()
  throw "Another Codex service login is already running."
}
try {

$codexExe = Join-Path $projectRoot `
  "node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe"
if (-not (Test-Path -LiteralPath $codexExe -PathType Leaf)) {
  throw "The pinned Codex 0.147.0 Windows runtime is not installed. Run npm install first."
}

function Assert-NoReparseTree([string]$Path) {
  $pending = New-Object System.Collections.Generic.Stack[string]
  $pending.Push($Path)
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    $currentItem = Get-Item -LiteralPath $current -Force
    if ($currentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      throw "Codex credential storage must not contain redirected paths."
    }
    foreach ($child in @(Get-ChildItem -LiteralPath $current -Force)) {
      if ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Codex credential storage must not contain redirected children."
      }
      if ($child.PSIsContainer) { $pending.Push($child.FullName) }
    }
  }
}

function Set-PrivateDirectoryAcl([string]$Path) {
  Assert-NoReparseTree $Path
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
  $icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
  & $icacls $Path /reset /T /C /L | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to reset the Codex directory ACL." }
  & $icacls $Path /inheritance:r /T /C /L | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to remove inherited Codex directory ACLs." }
  & $icacls $Path /grant:r `
    "*$($currentSid.Value):(OI)(CI)F" "*$($systemSid.Value):(OI)(CI)F" /T /C /L | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to grant the private Codex directory ACL." }

  $verified = Get-Acl -LiteralPath $Path
  if (-not $verified.AreAccessRulesProtected) {
    throw "Codex service home ACL still inherits permissions."
  }
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $allowedSids = @($currentSid.Value, $systemSid.Value)
  foreach ($rule in @($verified.Access)) {
    $sidValue = $rule.IdentityReference.Translate(
      [System.Security.Principal.SecurityIdentifier]
    ).Value
    if ($rule.AccessControlType -ne $allow -or $allowedSids -notcontains $sidValue) {
      throw "Codex service home ACL contains an unexpected principal."
    }
  }
}

function Set-PrivateFileAcl([string]$Path) {
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $systemSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
  $icacls = Join-Path $env:SystemRoot "System32\icacls.exe"
  & $icacls $Path /reset | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to reset the Codex auth file ACL." }
  & $icacls $Path /inheritance:r | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to remove inherited Codex auth file ACLs." }
  & $icacls $Path /grant:r `
    "*$($currentSid.Value):F" "*$($systemSid.Value):F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to grant the private Codex auth file ACL." }

  $verified = Get-Acl -LiteralPath $Path
  if (-not $verified.AreAccessRulesProtected) {
    throw "Codex auth file ACL still inherits permissions."
  }
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $allowedSids = @($currentSid.Value, $systemSid.Value)
  foreach ($rule in @($verified.Access)) {
    $sidValue = $rule.IdentityReference.Translate(
      [System.Security.Principal.SecurityIdentifier]
    ).Value
    if ($rule.AccessControlType -ne $allow -or $allowedSids -notcontains $sidValue) {
      throw "Codex auth file ACL contains an unexpected principal."
    }
  }
}

function Test-ChatGptAuth([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    $auth = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    return ([string]$auth.auth_mode -eq "chatgpt")
  } catch {
    return $false
  }
}

New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
New-Item -ItemType Directory -Path $codexHome -Force | Out-Null
foreach ($protectedPath in @($dataRoot, $codexHome)) {
  $item = Get-Item -LiteralPath $protectedPath -Force
  if (
    ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
    $item.PSDrive.Name -ne "D"
  ) {
    throw "Codex service auth directories must be real directories on D drive."
  }
}
Set-PrivateDirectoryAcl $codexHome
foreach ($forbidden in @(
  "AGENTS.md",
  "AGENTS.override.md",
  "config.toml",
  "managed_config.toml",
  "rules",
  "skills",
  "plugins",
  "memories"
)) {
  if (Test-Path -LiteralPath (Join-Path $codexHome $forbidden)) {
    throw "The Codex service home contains unapproved ambient context: $forbidden"
  }
}

$targetAuth = Join-Path $codexHome "auth.json"
$oldBackups = @(Get-ChildItem -LiteralPath $codexHome -Force -File |
  Where-Object { $_.Name -like "auth.json.replace-backup-*" })
if ($oldBackups.Count -gt 1) {
  throw "Multiple interrupted Codex auth replacements require manual review."
}
if ($oldBackups.Count -eq 1) {
  if (Test-ChatGptAuth $targetAuth) {
    Remove-Item -LiteralPath $oldBackups[0].FullName -Force
  } elseif (Test-ChatGptAuth $oldBackups[0].FullName) {
    if (Test-Path -LiteralPath $targetAuth) {
      Remove-Item -LiteralPath $targetAuth -Force
    }
    Move-Item -LiteralPath $oldBackups[0].FullName -Destination $targetAuth
  } else {
    throw "Interrupted Codex auth files are invalid and require manual review."
  }
}
if (Test-ChatGptAuth $targetAuth) {
  Set-PrivateFileAcl $targetAuth
}
Get-ChildItem -LiteralPath $codexHome -Force -File |
  Where-Object { $_.Name -like "auth.json.new-*" } |
  Remove-Item -Force

foreach ($staleLoginHome in @(Get-ChildItem -LiteralPath $dataRoot -Force -Directory |
  Where-Object { $_.Name -match '^codex-login-\d+$' })) {
  $staleFullPath = [System.IO.Path]::GetFullPath($staleLoginHome.FullName)
  if (-not $staleFullPath.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a Codex login directory outside project data."
  }
  if ($staleLoginHome.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw "Refusing to recursively clean a redirected Codex login directory."
  }
  Assert-NoReparseTree $staleFullPath
  Remove-Item -LiteralPath $staleFullPath -Recurse -Force
}

$temporaryHome = Join-Path $dataRoot ("codex-login-" + $PID)
$stagedAuth = Join-Path $codexHome ("auth.json.new-" + $PID)
$replacementBackup = Join-Path $codexHome ("auth.json.replace-backup-" + $PID)
$installedNewAuth = $false
if (Test-Path -LiteralPath $temporaryHome) {
  throw "The temporary Codex login directory already exists."
}
New-Item -ItemType Directory -Path $temporaryHome | Out-Null
Set-PrivateDirectoryAcl $temporaryHome

$oldCodexHome = $env:CODEX_HOME
try {
  $env:CODEX_HOME = $temporaryHome
  Write-Host "Complete the OpenAI device authorization for the director service account."
  & $codexExe login --device-auth
  if ($LASTEXITCODE -ne 0) {
    throw "Codex device login failed with exit code $LASTEXITCODE."
  }
  & $codexExe login status
  if ($LASTEXITCODE -ne 0) {
    throw "Codex service login status validation failed."
  }

  $temporaryAuth = Join-Path $temporaryHome "auth.json"
  if (-not (Test-ChatGptAuth $temporaryAuth)) {
    throw "Codex login did not create valid ChatGPT subscription authentication."
  }
  Copy-Item -LiteralPath $temporaryAuth -Destination $stagedAuth
  if (-not (Test-ChatGptAuth $stagedAuth)) {
    throw "Staged Codex service authentication failed validation."
  }

  if (Test-Path -LiteralPath $targetAuth) {
    [System.IO.File]::Replace($stagedAuth, $targetAuth, $replacementBackup, $true)
  } else {
    [System.IO.File]::Move($stagedAuth, $targetAuth)
  }
  $installedNewAuth = $true
  if (-not (Test-ChatGptAuth $targetAuth)) {
    throw "Installed Codex service authentication failed validation."
  }
  Set-PrivateDirectoryAcl $codexHome
  Set-PrivateFileAcl $targetAuth
  if (Test-Path -LiteralPath $replacementBackup) {
    Remove-Item -LiteralPath $replacementBackup -Force
  }
  Write-Host "Codex service ChatGPT login initialized in data/codex-home."
} catch {
  if (Test-Path -LiteralPath $replacementBackup) {
    if (Test-Path -LiteralPath $targetAuth) {
      Remove-Item -LiteralPath $targetAuth -Force
    }
    Move-Item -LiteralPath $replacementBackup -Destination $targetAuth -Force
    Set-PrivateDirectoryAcl $codexHome
    Set-PrivateFileAcl $targetAuth
  } elseif ($installedNewAuth -and (Test-Path -LiteralPath $targetAuth)) {
    Remove-Item -LiteralPath $targetAuth -Force
  }
  throw
} finally {
  $env:CODEX_HOME = $oldCodexHome
  foreach ($cleanupPath in @($stagedAuth, $temporaryHome)) {
    if (-not (Test-Path -LiteralPath $cleanupPath)) { continue }
    $fullCleanupPath = [System.IO.Path]::GetFullPath($cleanupPath)
    if (-not $fullCleanupPath.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to clean a path outside the project data directory."
    }
    $cleanupItem = Get-Item -LiteralPath $fullCleanupPath -Force
    if ($cleanupItem.PSIsContainer) {
      Assert-NoReparseTree $fullCleanupPath
    } elseif ($cleanupItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
      throw "Refusing to clean a redirected Codex login file."
    }
    Remove-Item -LiteralPath $fullCleanupPath -Recurse -Force
  }
}
} finally {
  if ($mutexAcquired) {
    try { [void]$mutex.ReleaseMutex() } catch { }
  }
  $mutex.Dispose()
}

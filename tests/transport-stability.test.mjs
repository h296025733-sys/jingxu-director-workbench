import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function ps(command) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('slow live origin never retires the public tunnel', () => {
  assert.equal(ps(". ./scripts/transport-health-policy.ps1; Get-TunnelHealthAction $false $true 3 6; Get-TunnelHealthAction $false $true 20 20"), 'keep-origin-busy\r\nkeep-origin-busy');
});
test('dead origin waits for confirmation; edge recovery requires healthy origin', () => {
  const result = ps(". ./scripts/transport-health-policy.ps1; Get-TunnelHealthAction $false $false 2 6; Get-TunnelHealthAction $false $false 3 6; Get-TunnelHealthAction $true $true 0 5; Get-TunnelHealthAction $true $true 0 6");
  assert.deepEqual(result.split(/\r?\n/), ['wait', 'recover-origin', 'wait', 'recover-tunnel']);
});
test('changed PowerShell scripts parse with Windows PowerShell 5.1', () => {
  ps("$files = @('start-server','start-public-access','public-access-worker','transport-health-policy','install-autostart'); foreach ($f in $files) { $tokens=$null; $parseErrors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PWD ('scripts/'+$f+'.ps1')), [ref]$tokens, [ref]$parseErrors); if ($parseErrors) { throw ($parseErrors | Out-String) } }");
});
test('web keepalive exceeds unchanged tunnel default; interactive priority is normal', () => {
  const source = readFileSync('scripts/start-server.ps1', 'utf8');
  const timeout = Number(source.match(/"--keepAliveTimeout", "(\d+)"/)[1]);
  assert.ok(timeout > 90000);
  assert.match(source, /\$p\.PriorityClass = 'Normal'/);
  assert.match(readFileSync('scripts/install-autostart.ps1', 'utf8'), /-Priority 4/);
});
test('controlled runtime repair gates restart on idle and preserves build', () => {
  const source = readFileSync('scripts/start-public-access.ps1', 'utf8').split('function Invoke-PendingTransportRepair')[1];
  assert.ok(source.indexOf('check-edit-release-idle.mjs') < source.indexOf('Stop-ManagedServerForDeployment'));
  assert.match(source, /deferred-active-work/);
  assert.match(source, /CreationDate\.ToUniversalTime/);
  assert.match(source, /Managed process changed/);
  assert.match(source, /supervisor-updated-same-tunnel/);
});

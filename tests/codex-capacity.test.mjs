import assert from 'node:assert/strict';
import test from 'node:test';

test('different module instances share four permits; FIFO cancellation and double release do not leak',async()=>{
  process.env.DW_CODEX_CONCURRENCY='4';
  const a=await import('../lib/codex-capacity.ts?feature=a');
  const b=await import('../lib/codex-capacity.ts?feature=b');
  const signal=()=>new AbortController().signal;
  const releases=await Promise.all(Array.from({length:4},()=>a.acquireCodexExecutionSlot(signal())));
  assert.equal(b.codexCapacitySnapshot().active,4);
  const abort=new AbortController();
  const canceled=b.acquireCodexExecutionSlot(abort.signal);
  const cancellation=assert.rejects(canceled,/canceled/);
  const started=[];
  const waiting=Array.from({length:12},(_,i)=>b.acquireCodexExecutionSlot(signal()).then(release=>{started.push(i);assert.ok(a.codexCapacitySnapshot().active<=4);release();release();}));
  assert.equal(a.codexCapacitySnapshot().waiting,13);
  abort.abort(); await cancellation;
  releases.forEach(release=>{release();release();});
  await Promise.all(waiting);
  assert.deepEqual(started,Array.from({length:12},(_,i)=>i));
  assert.deepEqual(a.codexCapacitySnapshot(),{limit:4,active:0,waiting:0});
  const alreadyAborted=new AbortController(); alreadyAborted.abort();
  await assert.rejects(a.acquireCodexExecutionSlot(alreadyAborted.signal),/canceled/);
});

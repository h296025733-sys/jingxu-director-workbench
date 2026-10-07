import assert from 'node:assert/strict';
import test from 'node:test';
import { concurrencyConfig, MAX_PENDING_WORK_GLOBAL } from '../lib/concurrency-config.ts';
import { mediaParallelism, createMediaGate } from '../lib/local-media-capacity.ts';
const GiB=1024**3;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('eight cloud/employee slots, three editing pipelines, at most two local workers; overrides only lower limits',()=>{
  assert.deepEqual(concurrencyConfig({}),{total:8,editing:3,localMedia:2});
  assert.deepEqual(concurrencyConfig({DW_CODEX_CONCURRENCY:'2',DW_EDITING_CONCURRENCY:'3'}),{total:2,editing:2,localMedia:2});
  assert.deepEqual(concurrencyConfig({DW_CODEX_CONCURRENCY:'999',DW_EDITING_CONCURRENCY:'999',DW_LOCAL_MEDIA_CONCURRENCY:'999'}),{total:8,editing:3,localMedia:2});
  assert.equal(MAX_PENDING_WORK_GLOBAL,32);
});

test('media admission uses free RAM and measured CPU rather than installed RAM or Windows loadavg',()=>{
  const base={freeBytes:12*GiB,parallelism:16,cpuPercent:30};
  assert.equal(mediaParallelism(base),2);
  assert.equal(mediaParallelism({...base,freeBytes:5*GiB}),1);
  assert.equal(mediaParallelism({...base,freeBytes:1.5*GiB}),0);
  assert.equal(mediaParallelism({...base,cpuPercent:75}),1);
  assert.equal(mediaParallelism({...base,cpuPercent:null}),1);
  assert.equal(mediaParallelism({...base,parallelism:8}),1);
  assert.equal(mediaParallelism(base,1),1);
});

test('pressure postpones new media workers without killing active work; recovery, FIFO and cancellation release cleanly',async()=>{
  let resources={freeBytes:12*GiB,parallelism:16,cpuPercent:20};
  const gate=createMediaGate(()=>resources);
  const first=await gate.acquire(),second=await gate.acquire();
  assert.equal(gate.snapshot().active,2);
  const abort=new AbortController();
  const canceled=gate.acquire(abort.signal);
  const rejection=assert.rejects(canceled,/取消/); abort.abort(); await rejection;
  let entered=false;
  const third=gate.acquire(undefined,()=>{throw new Error('broken progress callback');}).then(release=>{entered=true;return release;});
  resources={...resources,freeBytes:3*GiB}; gate.refresh();
  first();first(); await tick();assert.equal(entered,false);
  second();const thirdRelease=await third;
  assert.equal(gate.snapshot().active,1);
  resources={...resources,freeBytes:GiB};
  const last=gate.acquire(); thirdRelease();await tick();assert.equal(gate.snapshot().waiting,1);
  resources={...resources,freeBytes:12*GiB};gate.refresh();(await last)();
  assert.equal(gate.snapshot().active,0);assert.equal(gate.snapshot().waiting,0);
});

test('three simultaneous editing pipelines leave room for other owners in an eight-job scheduler',async()=>{
  const {enqueueWork,workSchedulerSnapshot}=await import('../lib/work-scheduler.ts');
  let active=0,editing=0,maxActive=0,maxEditing=0,ownerConflict=false;
  const owners=new Set();const finishes=[];
  const jobs=[...Array.from({length:4},(_,i)=>[`edit-${i}`,`editor-${i}`,'editing']),...Array.from({length:7},(_,i)=>[`other-${i}`,`owner-${i}`,'director']),['editor-followup','editor-0','image']];
  await new Promise(resolve=>{
    for(const [id,owner,kind] of jobs) enqueueWork({id,owner,kind,priority:1,run:async()=>{
      if(owners.has(owner))ownerConflict=true;owners.add(owner);
      active++;if(kind==='editing')editing++;
      maxActive=Math.max(maxActive,active);maxEditing=Math.max(maxEditing,editing);
      await new Promise(end=>setTimeout(end,25));
      active--;if(kind==='editing')editing--;owners.delete(owner);
      finishes.push(id);if(finishes.length===jobs.length)resolve();
    }});
  });
  await tick();assert.equal(maxActive,8);assert.equal(maxEditing,3);assert.equal(ownerConflict,false);
  assert.deepEqual(workSchedulerSnapshot().active,[]);assert.deepEqual(workSchedulerSnapshot().queued,[]);
});

test('all cloud features share eight actual permits across independently imported route modules',async()=>{
  const a=await import('../lib/codex-capacity.ts?eight=a');const b=await import('../lib/codex-capacity.ts?eight=b');
  const signal=()=>new AbortController().signal;
  const held=await Promise.all(Array.from({length:8},()=>a.acquireCodexExecutionSlot(signal())));
  assert.equal(b.codexCapacitySnapshot().active,8);
  let ninthStarted=false;const ninth=b.acquireCodexExecutionSlot(signal()).then(release=>{ninthStarted=true;release();});
  await tick();assert.equal(ninthStarted,false);
  held[0]();await ninth;held.forEach(release=>release());
  assert.deepEqual(a.codexCapacitySnapshot(),{limit:8,active:0,waiting:0});
});

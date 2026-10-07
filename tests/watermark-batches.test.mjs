import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { randomUUID } from 'node:crypto';
import { db } from '../lib/db.ts';
import { addWatermarkBatchItem, dispatchWaitingWatermarks, cancelWaitingWatermarkItem, listWatermarkBatchItems } from '../lib/watermark-batches.ts';
import { watermarkFileProblem } from '../lib/watermark-batch-contract.ts';
assert.ok(process.env.DW_TEST_DATA_DIR, 'isolated data required');
beforeEach(() => {
  for (const table of ['watermark_batch_items','tasks','task_delivery_packages','task_prompt_translations','videos']) db.exec(`DELETE FROM ${table}`);
  for (const owner of ['batch_a','batch_b']) db.prepare("INSERT OR IGNORE INTO users(username,password_hash,display_name,created_at) VALUES (?,'fixture',?,'2026-09-23')").run(owner,owner);
  db.prepare("UPDATE users SET disabled=0 WHERE username IN ('batch_a','batch_b')").run();
});
function video(owner='batch_a', mime='video/mp4') {
  const id=randomUUID();
  db.prepare("INSERT INTO videos(id,original_name,stored_name,mime_type,uploaded_by,created_at) VALUES (?, ?, ?, ?, ?, '2026-09-23')").run(id,`${id}.mp4`,`${id}.mp4`,mime,owner);
  return id;
}
function item(owner='batch_a', batchId=randomUUID(), videoId=video(owner)) {
  const payload={id:randomUUID(),batchId,videoId};addWatermarkBatchItem(owner,payload);return payload;
}
function task(owner='batch_a') {
  return Number(db.prepare("INSERT INTO tasks(video_id,feature_id,created_by,created_at,status) VALUES ('','omni_video',?,'2026-09-23','pending')").run(owner).lastInsertRowid);
}
test('20 durable items admitted without increasing 2-per-person execution admission',()=>{
  const batch=randomUUID();for(let i=0;i<20;i++)item('batch_a',batch);
  assert.equal(listWatermarkBatchItems('batch_a').length,20);
  assert.equal(dispatchWaitingWatermarks().length,1);
  assert.equal(dispatchWaitingWatermarks().length,1);
  assert.deepEqual(dispatchWaitingWatermarks(),[]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tasks WHERE status='pending'").get().n,2);
  assert.equal(listWatermarkBatchItems('batch_a').filter(x=>x.status==='waiting').length,18);
});
test('response loss retry is idempotent before and after dispatch and after completion',()=>{
  const original=item();assert.equal(addWatermarkBatchItem('batch_a',original),original.id);
  dispatchWaitingWatermarks();
  assert.equal(addWatermarkBatchItem('batch_a',original),original.id);
  db.exec("UPDATE tasks SET status='succeeded'");
  assert.equal(addWatermarkBatchItem('batch_a',original),original.id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM tasks').get().n,1);
  assert.throws(()=>addWatermarkBatchItem('batch_b',original),/提交编号/);
  assert.throws(()=>addWatermarkBatchItem('batch_a',{...original,videoId:video()}),/提交编号/);
});
test('same source within one batch deduplicates even with another item id',()=>{
  const original=item(); assert.equal(addWatermarkBatchItem('batch_a',{...original,id:randomUUID()}),original.id);
  assert.equal(listWatermarkBatchItems('batch_a').length,1);
});
test('private sources, list and cancellation remain owner scoped',()=>{
  const original=item();
  assert.throws(()=>item('batch_b',randomUUID(),original.videoId),/自己上传/);
  assert.throws(()=>item('batch_a',randomUUID(),video('batch_a','audio/wav')),/有效视频/);
  assert.deepEqual(listWatermarkBatchItems('batch_b'),[]);
  assert.throws(()=>cancelWaitingWatermarkItem('batch_b',original.id),/不存在/);
  cancelWaitingWatermarkItem('batch_a',original.id);
  cancelWaitingWatermarkItem('batch_a',original.id);
  assert.deepEqual(dispatchWaitingWatermarks(),[]);
});
test('busy owner does not block another owner; global 32 shared limit holds',()=>{
  task();task();item();item('batch_b');
  assert.equal(dispatchWaitingWatermarks().length,1);
  assert.equal(listWatermarkBatchItems('batch_a')[0].status,'waiting');
  db.exec('DELETE FROM tasks');
  for(let i=0;i<32;i++)task('other');
  assert.deepEqual(dispatchWaitingWatermarks(),[]);
});
test('fail/cancel of one task releases a slot; remaining items still dispatch',()=>{
  item();item();item();item();
  dispatchWaitingWatermarks();dispatchWaitingWatermarks();
  db.exec("UPDATE tasks SET status='failed' WHERE id=(SELECT MIN(id) FROM tasks)");
  assert.equal(dispatchWaitingWatermarks().length,1);
  db.exec("UPDATE tasks SET status='canceled' WHERE status='pending'");
  assert.equal(dispatchWaitingWatermarks().length,1);
});
test('disabled user and disappeared source are canceled without model scheduling',()=>{
  item();item('batch_b'); db.exec("UPDATE users SET disabled=1 WHERE username='batch_a'; DELETE FROM videos WHERE uploaded_by='batch_b'");
  assert.deepEqual(dispatchWaitingWatermarks(),[]);
  assert.equal(listWatermarkBatchItems('batch_a')[0].status,'canceled');
  assert.equal(listWatermarkBatchItems('batch_b')[0].status,'canceled');
});
test('person backlog bounded across batches; 21st never partly inserted',()=>{
  for(let i=0;i<20;i++)item();
  assert.throws(()=>item(),/20条/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM watermark_batch_items').get().n,20);
});
test('global durable backlog bounded at 100, independently of model slots',()=>{
  for(let owner=0;owner<5;owner++)for(let i=0;i<20;i++)item(`owner${owner}`);
  assert.throws(()=>item(),/清单暂时已满/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM watermark_batch_items').get().n,100);
});
test('upload preflight rejects empty/oversize/non-video, preserves MOV support',()=>{
  assert.equal(watermarkFileProblem({name:'real.MOV',size:1024}),null);
  assert.match(watermarkFileProblem({name:'bad.png',size:1024}),/视频/);
  assert.match(watermarkFileProblem({name:'empty.mp4',size:0}),/空/);
  assert.match(watermarkFileProblem({name:'large.mp4',size:1024**3+1}),/1GB/);
});

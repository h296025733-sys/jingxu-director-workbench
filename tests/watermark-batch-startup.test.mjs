import assert from 'node:assert/strict';
import { test } from 'node:test';
assert.ok(process.env.DW_TEST_DATA_DIR,'isolated DB required');
process.env.DW_WEB_SERVICE_PROCESS='1';
delete process.env.DW_SKIP_STARTUP_RECOVERY;
test('instrumentation and route module evaluations reconcile only once, without canceling newly accepted work',async()=>{
  const first=await import('../lib/db.ts?startup-first');
  const id=Number(first.db.prepare("INSERT INTO tasks(video_id,feature_id,status,created_by,created_at) VALUES('','watermark_removal','pending','fixture','2026-09-23')").run().lastInsertRowid);
  const second=await import('../lib/db.ts?startup-second');
  assert.equal(second.db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'pending');
  first.db.close();second.db.close();
});

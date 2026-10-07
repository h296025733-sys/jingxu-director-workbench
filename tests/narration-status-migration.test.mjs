import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

test('legacy delivery metadata migration preserves running work and does not trust success prose',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mirror-narration-migration-'));
 process.env.DW_TEST_DATA_DIR=dir;
 const old=new DatabaseSync(path.join(dir,'app.db'));
 old.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, video_id TEXT,video_name TEXT,feature_id TEXT,params_json TEXT,status TEXT,progress INTEGER,message TEXT,result_json TEXT,error TEXT,asset_schedule_complete INTEGER,created_by TEXT,created_at TEXT,started_at TEXT,finished_at TEXT)`);
 const insert=old.prepare(`INSERT INTO tasks (id,video_id,video_name,feature_id,params_json,status,progress,message,result_json,asset_schedule_complete,created_by,created_at) VALUES (?,'v','v.mp4','auto_edit',?, ?,100,'成功',?,1,'test','2026-09-17')`);
 const p=JSON.stringify({editVoice:'narration'});
 insert.run(1,p,'succeeded',JSON.stringify({extra:{editing:{narrationStatus:'partial',narrationNote:'已补充'}}}));
 insert.run(2,p,'succeeded',JSON.stringify({extra:{editing:{narrationStatus:'repaired_full_delivery'}}}));
 insert.run(3,p,'succeeded','{}');
 insert.run(4,p,'running','{}');
 insert.run(5,'{"editVoice":"original"}','succeeded','{}');
 insert.run(6,p,'succeeded','broken json');old.close();
 const {db}=await import('../lib/db.ts?delivery-migration');
 const states=db.prepare('SELECT id,status,edit_narration_status FROM tasks ORDER BY id').all();
 assert.deepEqual(states.map(s=>s.edit_narration_status),['partial','delivered','incomplete',null,null,null]);
 assert.equal(states[3].status,'running');
 const {toTaskSummaryOut}=await import('../lib/dto.ts');
 const summary=toTaskSummaryOut({...db.prepare('SELECT * FROM tasks WHERE id=1').get(),result_json:'not read by summary'});
 assert.equal(summary.narrationStatus,'partial');assert.equal(summary.result,null);
 db.close();
 // Fixture owned by this test only; leave its tiny directory for diagnostics.
});

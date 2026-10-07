import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DATA_DIR} from '../lib/paths.ts';
import {db} from '../lib/db.ts';

test('test worker receives a separate database before top-level server imports',()=>{
  assert.ok(process.env.DW_TEST_DATA_DIR);
  assert.notEqual(path.resolve(DATA_DIR).toLowerCase(),path.resolve('data').toLowerCase());
});

test('explicit maintenance import does not reset a live task in its isolated fixture',()=>{
  const id=Number(db.prepare("INSERT INTO tasks (video_id,feature_id,status,created_by,created_at) VALUES ('test','auto_edit','running','test',?)").run(new Date().toISOString()).lastInsertRowid);
  const p=spawnSync(process.execPath,['--import','./tests/typescript-loader.mjs','--conditions=react-server','--experimental-transform-types','-e',"import('./lib/db.ts').then(x=>x.db.close())"],{cwd:process.cwd(),env:{...process.env,DW_SKIP_STARTUP_RECOVERY:'1'},encoding:'utf8'});
  assert.equal(p.status,0,p.stderr);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'running');
  db.prepare('DELETE FROM tasks WHERE id=?').run(id);
});

test('a bare CLI import never impersonates a web restart, but the web marker reconciles',()=>{
  const id=Number(db.prepare("INSERT INTO tasks (video_id,feature_id,status,created_by,created_at) VALUES ('test','auto_edit','pending','test',?)").run(new Date().toISOString()).lastInsertRowid);
  const args=['--import','./tests/typescript-loader.mjs','--conditions=react-server','--experimental-transform-types','-e',"import('./lib/db.ts').then(x=>x.db.close())"];
  try {
    const bare=spawnSync(process.execPath,args,{cwd:process.cwd(),env:{...process.env,DW_WEB_SERVICE_PROCESS:'0',DW_SKIP_STARTUP_RECOVERY:'0'},encoding:'utf8'});
    assert.equal(bare.status,0,bare.stderr);
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'pending');
    const web=spawnSync(process.execPath,args,{cwd:process.cwd(),env:{...process.env,DW_WEB_SERVICE_PROCESS:'1',DW_SKIP_STARTUP_RECOVERY:'0'},encoding:'utf8'});
    assert.equal(web.status,0,web.stderr);
    assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(id).status,'failed');
  } finally {
    db.prepare('DELETE FROM tasks WHERE id=?').run(id);
  }
});

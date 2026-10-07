import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {checkpointNarration} from '../lib/narration-checkpoint.ts';

test('failed retry can restore verified stem even after overwriting its old path',()=>{
 const work=fs.mkdtempSync(path.join(os.tmpdir(),'narration-checkpoint-'));
 const source=path.join(work,'voiceover.wav');fs.writeFileSync(source,'verified-test-bytes');
 const ready={source,lines:[{text:'approved'}],captions:[{text:'approved'}]};
 const saved=checkpointNarration(ready,work);
 fs.writeFileSync(source,'partial-unverified-retry');
 assert.equal(fs.readFileSync(saved.source,'utf8'),'verified-test-bytes');
 assert.equal(saved.lines,ready.lines);assert.equal(saved.captions,ready.captions);
 assert.throws(()=>checkpointNarration(ready,work),/EEXIST/);
 assert.throws(()=>checkpointNarration(ready,fs.mkdtempSync(path.join(os.tmpdir(),'narration-other-'))),/escaped/);
 assert.deepEqual(checkpointNarration({lines:[]},work),{lines:[]});
});

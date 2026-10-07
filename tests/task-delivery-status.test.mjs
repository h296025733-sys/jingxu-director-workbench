import test from 'node:test';
import assert from 'node:assert/strict';
import {taskStatusMeta} from '../lib/format.ts';
import {narrationStatusFromResult} from '../lib/narration-delivery-status.ts';

test('explicit delivery record wins over optimistic words and localized labels',()=>{
 const params={editVoice:'narration'};
 for(const status of ['partial','incomplete','delivered']){
  const result={extra:{editing:{narrationStatus:status,narrationNote:'已补充：这是一条不可靠的旧说明'}}};
  assert.equal(narrationStatusFromResult(params,result),status);
 }
 assert.equal(narrationStatusFromResult(params,{}),'incomplete');
 assert.equal(narrationStatusFromResult({editVoice:'original'},{}),undefined);
 assert.equal(narrationStatusFromResult(params,{extra:{editing:{narrationStatus:'repaired_full_delivery'}}}),'delivered');
 assert.equal(taskStatusMeta({status:'succeeded',featureId:'auto_edit',narrationStatus:'partial',message:'Everything is ready'}).label,'配音待完善');
 assert.equal(taskStatusMeta({status:'succeeded',featureId:'auto_edit',narrationStatus:'incomplete',message:'一切已完成'}).label,'配音待完成');
 assert.equal(taskStatusMeta({status:'running',featureId:'auto_edit',narrationStatus:'incomplete'}).label,'执行中');
});

test('task340 missing narration is not displayed as complete success',()=>{
 assert.equal(taskStatusMeta({status:'succeeded',featureId:'auto_edit',message:'配音合成未完成；目前只能使用原声精剪版，不含你填写的画外解说。'}).label,'配音待完成');
 assert.equal(taskStatusMeta({status:'succeeded',featureId:'auto_edit',message:'已补充连续英文口播与10段同步字幕'}).label,'成功');
 assert.equal(taskStatusMeta({status:'succeeded',featureId:'auto_edit',message:'视频已经剪好'}).label,'成功');
 assert.equal(taskStatusMeta({status:'running',featureId:'auto_edit',message:'正在补充配音'}).label,'执行中');
});

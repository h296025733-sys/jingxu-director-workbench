import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeWatermarkCleanup, watermarkResultNote, watermarkExecutionNote} from '../lib/edit-watermarks.ts';
import {taskStatusMeta} from '../lib/format.ts';
import {applyEditTemplate} from '../lib/edit-templates.ts';
const sources=[{source:'inputs/a.mp4',kind:'video',durationSeconds:10}];
const r={source:'inputs/a.mp4',start:0,end:10,x:.8,y:.95,width:.17,height:.025,kind:'overlay_watermark',safe_to_remove:true,evidence_times:[0,5,9.8],evidence:'Fixed platform mark at bottom right over empty wall in all samples.'};
const clean=(x=r)=>normalizeWatermarkCleanup({inspected:true,regions:[x]},sources);

test('v3 permits long thin account lines, not broad wipes or unsafe text',()=>{
 for(const geometry of [{x:.02,y:.96,width:.96,height:.035},{x:.02,y:.02,width:.035,height:.96}]) {
  const raw={inspected:true,version:3,regions:[{...r,...geometry}]};
  const result=normalizeWatermarkCleanup(raw,sources);
  assert.equal(result.deferred,0);assert.equal(result.regions[0].safe_to_remove,true);
  assert.deepEqual(normalizeWatermarkCleanup(result,sources),result);
  for(const patch of [{safe_to_remove:false},{kind:'uncertain'}])
   assert.equal(normalizeWatermarkCleanup({...raw,regions:[{...raw.regions[0],...patch}]},sources).regions[0].safe_to_remove,false);
  assert.equal(normalizeWatermarkCleanup({...raw,version:2},sources).regions[0].safe_to_remove,false);
 }
 assert.equal(normalizeWatermarkCleanup({inspected:true,version:3,regions:[{...r,x:0,y:.8,width:1,height:.15}]},sources).regions[0].safe_to_remove,false);
});

test('v3 accepts bounded marks at every edge/center without platform-name assumptions',()=>{
 for(const x of [0,.4,.83]) for(const y of [0,.48,.975]) {
  const item={...r,x,y,evidence:'A black irregular overlay remains screen-fixed in these actual frames.'};
  const c=normalizeWatermarkCleanup({inspected:true,version:3,regions:[item]},sources);
  assert.equal(c.regions[0].safe_to_remove,true);assert.equal(c.deferred,0);
  assert.equal(c.regions[0].x,x);assert.equal(c.regions[0].y,y);
 }
});

test('v3 keeps separate fixed intervals for a jumping mark and retains simultaneous marks',()=>{
 const regions=[{...r,x:0,y:.3,start:0,end:5,evidence_times:[0,4.9]},
  {...r,x:.8,y:.3,start:5,end:10,evidence_times:[5,9.9]},
  {...r,x:.4,y:0}];
 const c=normalizeWatermarkCleanup({inspected:true,version:3,regions},sources);
 assert.equal(c.deferred,0);assert.equal(c.regions.length,3);
 assert.deepEqual(c.regions.map(q=>[q.start,q.end,q.x,q.y]),regions.map(q=>[q.start,q.end,q.x,q.y]));
});

test('v3 permits SS20 glyph search extent, never promotes explicitly unsafe/uncertain regions or crops',()=>{
 const region={...r,x:.754,y:.875,width:.228,height:.117};
 const v3=normalizeWatermarkCleanup({inspected:true,version:3,regions:[region]},sources);
 assert.equal(v3.regions[0].safe_to_remove,true);assert.equal(v3.version,3);
 assert.deepEqual(normalizeWatermarkCleanup(v3,sources),v3);
 assert.equal(clean(region).regions[0].safe_to_remove,false);
 for(const patch of [{safe_to_remove:false},{kind:'uncertain'},{width:.4,x:.5},{evidence_times:[0,.1]}]){
  assert.equal(normalizeWatermarkCleanup({inspected:true,version:3,regions:[{...region,...patch}]},sources).regions[0].safe_to_remove,false);
 }
 assert.equal(normalizeWatermarkCleanup({inspected:true,version:3,regions:[{...r,y:.966,height:.022,safe_to_remove:false}]},sources).regions[0].safe_to_remove,false);
});

test('execution report, not playable-file status, controls watermark delivery label',()=>{
 const message=watermarkExecutionNote({inspected:true,processed:0,deferred:1});
 assert.match(message,/已处理0处/);
 assert.equal(taskStatusMeta({status:'succeeded',featureId:'watermark_removal',message}).label,'去水印待完善');
 assert.equal(taskStatusMeta({status:'succeeded',featureId:'watermark_removal',message:'部分水印因位置不确定或会损伤主体未处理，已保留可用成片。'}).label,'去水印待完善');
 assert.equal(taskStatusMeta({status:'succeeded',featureId:'watermark_removal',message:watermarkExecutionNote({inspected:true,processed:0,deferred:0})}).label,'未检出水印');
});
test('contour renderer version survives normalization while old plans remain versionless',()=>{
 const v2=normalizeWatermarkCleanup({...clean(),version:2},sources);
 assert.equal(v2.version,2);assert.deepEqual(normalizeWatermarkCleanup(v2,sources),v2);
 assert.equal(clean().version,undefined);
});
test('all visual templates and legacy versions preserve shared source cleanup without changing shots or sound',()=>{
 for(const version of [1,2])for(const id of ['clear','focus','social','impact']){
  const p={clips:[{source:'inputs/a.mp4',kind:'video',start:0,end:10,speed:1,mute:false}],overlays:[],watermark_cleanup:clean()};
  const styled=applyEditTemplate(p,id,version);
  assert.deepEqual(styled.clips,p.clips);assert.deepEqual(styled.watermark_cleanup,p.watermark_cleanup);
 }
});
test('clean no-watermark footage remains unchanged and missing inspection is reported honestly',()=>{
 assert.equal(watermarkResultNote({watermark_cleanup:normalizeWatermarkCleanup({inspected:true,regions:[]},sources)}),'');
 assert.match(watermarkResultNote({}),/未完成水印识别/);
});
test('a bounded source mark with spanning evidence is retained for native removal',()=>{
 assert.equal(clean().regions[0].safe_to_remove,true);assert.equal(clean().regions[0].method,'interpolate');assert.equal(clean().deferred,0);
 assert.deepEqual(normalizeWatermarkCleanup(clean(),sources),clean());
});
test('a full-duration fixed bottom-edge mark is deterministically edge-cropped when interpolation is unsafe',()=>{
 const c=normalizeWatermarkCleanup({inspected:true,regions:[{...r,y:.966,height:.022,safe_to_remove:false,evidence:'Fixed Dola AI platform watermark crosses changing people and parking-lot backgrounds.'}],deferred:1},sources);
 assert.equal(c.regions[0].safe_to_remove,true);assert.equal(c.regions[0].method,'edge_crop');assert.equal(c.regions[0].crop_fraction,.04);assert.equal(c.deferred,0);
 assert.match(watermarkResultNote({watermark_cleanup:c}),/边缘裁切移除1处/);
 assert.deepEqual(normalizeWatermarkCleanup(c,sources),c);
});
test('edge crop never promotes a partial, high, or excessive region',()=>{
 for(const patch of [{start:1},{end:9},{y:.92},{y:.94,height:.02}]){
  const c=clean({...r,safe_to_remove:false,...patch});assert.equal(c.regions[0].safe_to_remove,false);assert.equal(c.deferred,1);
 }
});
test('product branding and original captions are never automatically erased',()=>{
 for(const kind of ['embedded_brand','caption'])assert.equal(clean({...r,kind}).regions.length,0);
});
test('moving/uncertain, oversized and insufficiently witnessed marks preserve usable output with warning',()=>{
 for(const patch of [{safe_to_remove:false},{kind:'uncertain'},{width:.4,x:.5},{height:.2,y:.7},{evidence_times:[0,.1]},{evidence_times:[5,6]},{evidence:'guess'}]){
  const c=clean({...r,...patch});assert.equal(c.regions[0].safe_to_remove,false);assert.equal(c.deferred,1);
  assert.match(watermarkResultNote({watermark_cleanup:c}),/保留可用成片/);
 }
});
test('malformed/escaped sources and nonfinite geometry cannot reach renderer',()=>{
 for(const patch of [{source:'../../other.mp4'},{x:NaN},{end:30},{x:.95},{height:-1}]){
  const c=clean({...r,...patch});assert.equal(c.regions.length,0);assert.equal(c.deferred,1);
 }
});

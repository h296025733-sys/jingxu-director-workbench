import assert from 'node:assert/strict';
import test from 'node:test';
import {EDIT_COLOR_STYLES,editColorStyle} from '../lib/edit-colors.ts';
import {applyEditTemplate,editTemplateValidationError} from '../lib/edit-templates.ts';
import {isColorPreviewName} from '../lib/clone-preview-files.ts';
test('all color choices preserve words, timing, original audio and template identity',()=>{
 const p={output:{width:1080,height:1920},clips:[{start:0,end:5,source:'inputs/main.mp4',mute:false}],overlays:[{kind:'caption',text:'Señal clara.',start:1,end:3,animation:'fade',highlights:[]}]};
 for(const t of ['clear','focus','social','impact']) for(const c of EDIT_COLOR_STYLES){
  const v=applyEditTemplate(p,t,3,c.id);
  assert.deepEqual(v.clips,p.clips);assert.equal(v.overlays[0].text,p.overlays[0].text);
  assert.equal(v.overlays[0].start,1);assert.equal(v.overlays[0].end,3);
  assert.equal(v.presentation.style,t);assert.equal(v.presentation.typography?.color??'original',c.id);
  assert.deepEqual(applyEditTemplate(v,t,3,c.id),v);
  assert.equal(editTemplateValidationError({editColorStyle:c.id}),null);
 }
 assert.equal(applyEditTemplate(p,'focus',3).presentation.typography,undefined);
 assert.ok(editTemplateValidationError({editColorStyle:'injected'}));assert.equal(editColorStyle(null),'original');
});
test('preview allowlist cannot expose arbitrary files or voice references',()=>{
 assert.equal(isColorPreviewName('color1-social-aurora-es.mp4'),true);
 for(const file of ['../input.json','color1-social-fake-es.mp4','color1-social-aurora-es.wav','color1-social-aurora-es.mp4/secret'])assert.equal(isColorPreviewName(file),false);
});

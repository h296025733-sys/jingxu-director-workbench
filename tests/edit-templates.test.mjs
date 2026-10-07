import assert from 'node:assert/strict';
import test from 'node:test';
import { EDIT_TEMPLATES, PREVIEW_VOICES, applyEditTemplate, editTemplateValidationError, editTemplatePrompt, normalizePreviewVoice, previewVoiceGender, VOICE_TEMPLATE_SLOTS } from '../lib/edit-templates.ts';

const sample = () => ({
  output: {width:1080,height:1920}, clips:[{source:'inputs/main.mp4',start:0,end:12,speed:1,mute:false}],
  picture_in_picture:[{source:'inputs/support.mp4',start:4,end:6}], music:null,
  overlays:[
    {kind:'title',text:'See the difference.',start:0.4,end:2.8,preset:'fine_hook',animation:'punch',highlights:[]},
    {kind:'caption',text:'Focus on what matters.',start:3,end:6,preset:'fine_caption',animation:'fade',highlights:[{text:'matters',color:'#123456',motion:'shake',start:5,end:5.5}]},
    {kind:'label',text:'Every word counts.',start:7,end:9,preset:'badge',animation:'tag',highlights:[]},
  ], transitions:[{after_clip:0,duration:0.2,type:'dissolve'}], finishing:{preset:'none'},
});

test('v3 is readable at native resolution while v1/v2 retain their old scale and timing',()=>{
 const p=sample();p.overlays[1].font_size=58;
 const legacy=applyEditTemplate(p,'social',2),v3=applyEditTemplate(p,'social',3);
 assert.equal(legacy.overlays[1].font_size,58);
 assert.ok(v3.overlays[1].font_size>=77);
 assert.deepEqual(v3.clips,p.clips);
 assert.deepEqual(v3.overlays.map(o=>[o.text,o.start,o.end]),p.overlays.map(o=>[o.text,o.start,o.end]));
 assert.deepEqual(applyEditTemplate(v3,'social',3),v3);
 assert.equal(editTemplateValidationError({editTemplateId:'social',editTemplateVersion:3,editNarrationDepth:'full'}),null);
 assert.ok(editTemplateValidationError({editNarrationDepth:'verbose'}));
});
test('four templates produce distinct real treatments without changing source, words, timestamps or audio',()=>{
  const original=sample();
  const fingerprints=new Set();
  for (const template of EDIT_TEMPLATES) {
    const plan=applyEditTemplate(original,template.id,2);
    assert.deepEqual(plan.clips,original.clips);
    assert.deepEqual(plan.picture_in_picture,original.picture_in_picture);
    assert.deepEqual(plan.transitions,original.transitions);
    assert.deepEqual(plan.overlays.map(({text,start,end})=>({text,start,end})),original.overlays.map(({text,start,end})=>({text,start,end})));
    assert.deepEqual(applyEditTemplate(plan,template.id,2),plan);
    fingerprints.add(JSON.stringify(plan.overlays));
    assert.ok(editTemplatePrompt(template.id,2).includes(template.name));
  }
  assert.equal(fingerprints.size,4);
  assert.deepEqual(sample(),original);
});
test('legacy edits remain unchanged; unknown templates and unavailable dubbing cannot enter production',()=>{
  const plan=sample();
  assert.equal(applyEditTemplate(plan,''),plan);
  assert.equal(editTemplateValidationError({}),null);
  assert.ok(editTemplateValidationError({editTemplateId:'fake'}));
  assert.ok(editTemplateValidationError({editTemplateId:'focus',editTemplateVersion:55}));
  assert.ok(editTemplateValidationError({editVoice:'female'}));
  assert.ok(VOICE_TEMPLATE_SLOTS.every(slot=>slot.productionEnabled===true));
  assert.equal(editTemplateValidationError({editVoice:'narration',editNarrator:'male',editEmotion:'neutral'}),null);
  assert.equal(editTemplateValidationError({editVoice:'narration',editNarrator:'male',editVoiceProfile:'male-3',editEmotion:'neutral'}),null);
  assert.ok(editTemplateValidationError({editVoice:'narration',editNarrator:'male',editVoiceProfile:'male-9',editEmotion:'neutral'}));
  assert.equal(editTemplateValidationError({editVoice:'narration',voiceReferenceVideoId:'source-video'}),null);
  assert.ok(editTemplateValidationError({editVoice:'original',voiceReferenceVideoId:'source-video'}));
  assert.ok(editTemplateValidationError({editVoice:'narration',editAudio:'mute'}));
  assert.ok(editTemplatePrompt('clear',1).includes('清透字幕'));
});

test('numbered built-in voice profiles keep legacy tasks compatible and retain gender',()=>{
  assert.deepEqual(PREVIEW_VOICES.map((voice)=>voice.id),[
    'female-1','female-2','female-3','female-4','male-1','male-2','male-3',
  ]);
  assert.equal(normalizePreviewVoice(undefined,'female'),'female-1');
  assert.equal(normalizePreviewVoice(undefined,'male'),'male-1');
  assert.equal(normalizePreviewVoice('female-4','male'),'female-4');
  assert.equal(previewVoiceGender('female-4'),'female');
  assert.equal(previewVoiceGender('male-3'),'male');
});
test('clear removes kinetic word motion; impact has one shake ceiling',()=>{
  const plan=sample();
  const clear=applyEditTemplate(plan,'clear');
  assert.equal(clear.overlays[1].highlights[0].motion,'none');
  assert.ok(clear.overlays.every(o=>['none','fade'].includes(o.animation)));
  plan.overlays.push({...plan.overlays[1],start:32,end:36,highlights:[{text:'matters',motion:'shake',start:35,end:35.5}]});
  const impact=applyEditTemplate(plan,'impact');
  assert.equal(impact.overlays.flatMap(o=>o.highlights).filter(h=>h.motion==='shake').length,1);
});

test('presentation never recasts a valid medium fact into an overlong art accent',()=>{
 const p=sample();p.overlays[2].text='The bottle caught my attention';
 for(const version of [2,3]){
  assert.equal(applyEditTemplate(p,'social',version).overlays[2].preset,'feature');
 }
 p.overlays[0].text='What happens on the card?';
 assert.equal(applyEditTemplate(p,'clear',3).overlays[0].preset,'fine_hook');
});

test('v3 preserves evidence-led micro, fact and CTA hierarchy instead of flattening every label',()=>{
 const p=sample();
 p.overlays=[
  {kind:'label',text:'One spray',start:1,end:2,preset:'fine_micro',animation:'fade',highlights:[]},
  {kind:'label',text:'Visible proof',start:4,end:5,preset:'feature',animation:'fade',highlights:[]},
  {kind:'title',text:'Try it tonight',start:10,end:11.5,preset:'fine_cta',animation:'cta_hold',highlights:[]},
 ];
 const styled=applyEditTemplate(p,'focus',3);
 assert.deepEqual(styled.overlays.map(o=>o.preset),['fine_micro','feature','fine_cta']);
 assert.ok(styled.overlays[0].font_size < styled.overlays[1].font_size);
 assert.ok(styled.overlays[1].font_size < styled.overlays[2].font_size);
 assert.deepEqual(applyEditTemplate(styled,'focus',3),styled);
 assert.equal(applyEditTemplate(p,'focus',2).overlays[0].preset,'feature');
});

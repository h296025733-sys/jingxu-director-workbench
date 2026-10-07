import test from 'node:test';
import assert from 'node:assert/strict';
import {safeNarrationLines,transcriptSpeechSpans,sourceSpeechProfile,narrationDepth,narrationInstruction,needsContinuousNarration} from '../lib/edit-narration.ts';
import {safeEditGraphics} from '../lib/edit-graphics.ts';
import {withVoiceSlot} from '../lib/voice-capacity.ts';
const line={start:1,end:5,text:'The speaker separates into two parts.',evidence:'The source shows the two speaker halves separating on the desk.'};
const plan=()=>({clips:[{kind:'video',source:'inputs/main.mp4',start:2,end:12,speed:1}],narration:[line]});

test('task340 AUTO long narration uses the continuous TTS contract independent of depth',()=>{
 assert.equal(needsContinuousNarration([{...line,start:.2,end:21.9}]),true);
 assert.equal(needsContinuousNarration([{...line,text:'x'.repeat(241)}]),true);
 assert.equal(needsContinuousNarration([line]),false);
 assert.equal(needsContinuousNarration([line],true),true);
});

test('audio classification separates absent track, missing recognition, mixed and dense speech',()=>{
 const a=(probe,transcript_path)=>({assets:[{kind:'video',job_path:'inputs/main.mp4',probe,transcript_path}]});
 assert.equal(sourceSpeechProfile(a({audio:null,duration_seconds:10}),[]).kind,'no_audio_track');
 assert.equal(sourceSpeechProfile(a({audio:{},duration_seconds:10}),[]).kind,'unknown');
 assert.equal(sourceSpeechProfile(a({audio:{},duration_seconds:10},'t.json'),[]).kind,'no_recognized_speech');
 assert.equal(sourceSpeechProfile(a({audio:{},duration_seconds:10},'t.json'),[{source:'inputs/main.mp4',start:0,end:8}]).kind,'speech_led');
 assert.equal(sourceSpeechProfile(a({audio:{},duration_seconds:10},'t.json'),[{source:'inputs/main.mp4',start:2,end:3}]).kind,'mixed');
 assert.equal(sourceSpeechProfile(a({audio:{},duration_seconds:'bad'},'t.json'),[{source:'inputs/main.mp4',start:2,end:3}]).kind,'unknown');
 assert.equal(narrationDepth('invalid'),'auto');
 assert.match(narrationInstruction(true,'full'),/完整讲解/);
 assert.match(narrationInstruction(false,'full'),/narration必须为\[\]/);
});

test('full narration may bridge inspected speech-free main cuts, never unknown tracks or speech',()=>{
 const p=plan();p.clips=[{kind:'video',source:'inputs/main.mp4',start:0,end:3},{kind:'video',source:'inputs/main.mp4',start:4,end:11}];
 const options={depth:'full',allowAcrossCuts:true,inspectedSources:['inputs/main.mp4']};
 assert.equal(safeNarrationLines(p,[],true,options).lines.length,1);
 p.narration=[{...line,start:0,end:5}];assert.equal(safeNarrationLines(p,[],true,options).lines.length,1);
 assert.equal(safeNarrationLines(p,[],true,{...options,inspectedSources:[]}).lines.length,0);
 assert.equal(safeNarrationLines(p,[{source:'inputs/main.mp4',start:4,end:5}],true,options).lines.length,0);
 p.transitions=[{after_clip:0,duration:.2}];
 assert.equal(safeNarrationLines(p,[],true,options).lines.length,0);
});

test('brief limits clutter, full can keep four factual groups and safe caption coordinates persist',()=>{
 const p=plan();p.clips[0].end=32;
 p.narration=[1,7,13,20].map(start=>({...line,start,end:start+4,x:.4,y:.2,align:8}));
 assert.equal(safeNarrationLines(p,[],true,{depth:'brief'}).lines.length,3);
 const full=safeNarrationLines(p,[],true,{depth:'full'}).lines;
 assert.equal(full.length,4);assert.equal(full[0].y,.2);
 p.narration[0].y=.99;assert.equal(safeNarrationLines(p,[],true,{depth:'full'}).lines.length,3);
});

test('short natural phrases reach actual synthesis and overlapping narration only narrows its own window',()=>{
 const p=plan();p.clips=[{kind:'video',source:'inputs/main.mp4',start:0,end:22}];
 p.narration=[{...line,start:0,end:5,text:'The carry handle frames controls above the illuminated front.'},{...line,start:5.1,end:7.2,text:'Controls surround the central dial.'},{...line,start:7.28,end:10.08,text:'Two grilles fill the rear.'},{...line,start:11.15,end:16.9,text:'In lower light, both side strips cycle through distinct colors.'},{...line,start:16,end:21.32,text:'The centered front gives the color sequence a clear finish.'}];
 const before=structuredClone(p);
 const result=safeNarrationLines(p,[],true,{depth:'full',allowAcrossCuts:true,inspectedSources:['inputs/main.mp4']});
 assert.equal(result.lines.length,5);assert.equal(result.rejected.length,0);
 assert.ok(Math.abs(result.lines[4].start-17.1)<.001);
 assert.equal(result.lines[4].end,21.32);assert.deepEqual(p,before);
 assert.equal(safeNarrationLines(p,[{source:'inputs/main.mp4',start:0,end:22}],true,{allowAcrossCuts:true}).lines.length,0);
});
test('off means no narration and source timing maps into the output speech clock',()=>{
 assert.equal(safeNarrationLines(plan(),[],false).lines.length,0);
 assert.equal(safeNarrationLines(plan(),[],true).lines.length,1);
 assert.equal(safeNarrationLines(plan(),[{source:'inputs/main.mp4',start:3,end:6}],true).lines.length,0);
});
test('invalid, too-dense and cross-cut additions are omitted without rewriting the edit',()=>{
 const p=plan(),before=structuredClone(p);
 p.narration=[{...line,end:2},{...line,start:9,end:14},{...line,text:'a '.repeat(70)}];
 assert.equal(safeNarrationLines(p,[],true).lines.length,0);
 assert.deepEqual(p.clips,before.clips);
});
test('retimed original speech still blocks overlapping new narration',()=>{
 const p=plan();p.clips[0].speed=1.25;
 assert.equal(safeNarrationLines(p,[{source:'inputs/main.mp4',start:5,end:7}],true).lines.length,0);
});

test('measured words preserve real gaps inside a broad transcript segment',()=>{
 const speech=transcriptSpeechSpans('inputs/main.mp4',{segments:[{start:2,end:12,words:[{start:2,end:2.5},{start:10,end:12}]}]});
 assert.equal(speech.length,2);
 assert.equal(safeNarrationLines(plan(),speech,true).lines.length,1);
 assert.equal(transcriptSpeechSpans('x',{segments:[{start:2,end:12}]}).length,1);
 const p=plan();p.overlays=[{kind:'caption',start:2,end:4,y:.7}];
 assert.equal(safeNarrationLines(p,[],true).lines.length,0);
});
test('graphics permit only bounded renderer shapes and safe geometry',()=>{
 const g={kind:'ring',direction:'right',x:.4,y:.4,width:.2,height:.2,start:1,end:2,evidence:'Stationary visible speaker button at source 1s'};
 assert.equal(safeEditGraphics([g]).length,1);
 assert.equal(safeEditGraphics([{...g,x:.9}]).length,0);
 assert.equal(safeEditGraphics([{...g,kind:'eval'}]).length,0);
 assert.equal(safeEditGraphics([g,{...g,start:1.5,end:2.5}]).length,1);
});

test('voice synthesis uses one nested permit and releases it after an error',async()=>{
 let active=0,peak=0;
 const run=()=>withVoiceSlot(new AbortController().signal,async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,15));active--;});
 await Promise.all([run(),run(),run()]);assert.equal(peak,1);
 await assert.rejects(()=>withVoiceSlot(new AbortController().signal,async()=>{throw Error('test failure');}),/test failure/);
 await run();assert.equal(active,0);
});

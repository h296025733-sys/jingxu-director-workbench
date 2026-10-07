import test from 'node:test';import assert from 'node:assert/strict';
import {auditSpokenCaptionCoverage} from '../lib/edit-caption-coverage.ts';
test('an art keyword cannot silently replace an entire sentence',()=>{
 const words=['Ese','silencio','fue','más','claro'].map((text,i)=>({source:'a.mp4',text,start:i*.3,end:i*.3+.25}));
 const p={clips:[{source:'a.mp4',start:0,end:2,speed:1}],overlays:[{kind:'label',text:'más claro',start:0,end:2}]};
 assert.equal(auditSpokenCaptionCoverage(p,words).possibleMissingWords,3);
 p.overlays.unshift({kind:'caption',text:'Ese silencio fue',start:0,end:1});
 assert.equal(auditSpokenCaptionCoverage(p,words).possibleMissingWords,0);
});
test('coverage uses selected source clock and ignores omitted or explicitly muted speech',()=>{
 const words=[{source:'a.mp4',text:'Hello',start:2,end:2.4},{source:'a.mp4',text:'omitted',start:7,end:8}];
 const p={clips:[{source:'a.mp4',start:2,end:4,speed:2}],overlays:[{text:'Hello!',start:0,end:.3}]};
 assert.equal(auditSpokenCaptionCoverage(p,words).selectedWords,1);
 assert.equal(auditSpokenCaptionCoverage(p,words).possibleMissingWords,0);
 p.clips[0].mute=true;assert.equal(auditSpokenCaptionCoverage(p,words).selectedWords,0);
});

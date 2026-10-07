import fs from 'node:fs';
import {EDIT_TEMPLATES,applyEditTemplate} from '../lib/edit-templates.ts';
const version=Number(process.argv[2]??2);if(![2,3].includes(version))throw Error('Unsupported showroom version');
const root=`data/voice-templates/v${version}`;fs.mkdirSync(root,{recursive:true});
const manifest=JSON.parse(fs.readFileSync('data/voice-templates/v1/audition-manifest.json','utf8'));
const qa=JSON.parse(fs.readFileSync('data/voice-templates/v1/audition-qa.json','utf8'));
const clips=[];
for(const audio of manifest.files){
 const checked=qa.files.find(x=>x.name===audio.name);if(!(checked.exactWords||checked.spacingEquivalent))throw Error('Unchecked voice');
 const phrases=audio.language==='en'?['See the difference.','Focus on what matters.','Make every word count.']:['Mira la diferencia.','Destaca lo importante.','Cada palabra cuenta.'];
 const norm=s=>s.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]/g,'');
 let count=0;const ends=checked.words.map(w=>(count+=norm(w.text).length));let cursor=0;
 const overlays=phrases.map((text,i)=>{let first=ends.findIndex(n=>n>cursor),last=ends.findIndex(n=>n>=cursor+norm(text).length);cursor+=norm(text).length;return {kind:['title','caption','label'][i],text,start:checked.words[first].start+.35,end:checked.words[last].end+.45,preset:'default',animation:i===1?'fade':'pop',effect_reason:['hook','readability','cta'][i],highlights:[],x:.48,y:[.30,.70,.48][i],align:5,layer:10}});
 for(const t of EDIT_TEMPLATES){
  const raw={output:{width:540,height:960},overlays:structuredClone(overlays)};
  if(t.id==='social')raw.overlays.push({kind:'label',text:'✨',start:overlays[0].start,end:overlays[0].end,preset:'fine_reaction',animation:'bounce',effect_reason:'payoff',highlights:[],x:.73,y:.45,align:5,layer:15});
  if(t.id==='focus')raw.overlays.push({kind:'label',text:'→',start:overlays[2].start,end:overlays[2].end,preset:'fine_reaction',animation:'tag',effect_reason:'cta',highlights:[],x:.19,y:.48,align:5,layer:15});
  if(t.id==='impact')raw.overlays[0].animation='punch';
  if(t.id==='social')raw.overlays[2].animation='bounce';
  const plan=applyEditTemplate(raw,t.id,version);
  clips.push({name:`${t.id}-${audio.language}-${audio.voice}-${audio.emotion}`,voice:audio.name,seconds:audio.seconds+.9,...plan});
 }
}
fs.writeFileSync(root+'/showroom-input.json',JSON.stringify({clips},null,2));

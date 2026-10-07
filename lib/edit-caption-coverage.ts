/** A diagnostic, not a rejection gate: ASR/spelling can be imperfect. */
type R=Record<string,unknown>;
const obj=(v:unknown):R=>v&&typeof v==='object'&&!Array.isArray(v)?v as R:{};
const tokens=(s:unknown):string[]=>String(s??'').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
export function auditSpokenCaptionCoverage(plan:unknown, words:readonly {source:string;start:number;end:number;text:string}[]) {
 const p=obj(plan),overlays=(Array.isArray(p.overlays)?p.overlays:[]).map(obj);
 const clips=(Array.isArray(p.clips)?p.clips:[]).map(obj);
 const transitions=new Map((Array.isArray(p.transitions)?p.transitions:[]).map(v=>{const t=obj(v);return [Number(t.after_clip),Number(t.duration)];}));
 const missing:{at:number;text:string}[]=[];let at=0,selectedWords=0;
 for(const [index,c] of clips.entries()){
  const speed=Number(c.speed??1),duration=c.kind==='image'?Number(c.duration):(Number(c.end)-Number(c.start))/speed;
  if(!Number.isFinite(duration)||duration<=0)continue;
  if(c.kind!=='image'&&c.mute!==true){
   for(const w of words){
    if(w.source.replaceAll('\\','/')!==String(c.source).replaceAll('\\','/'))continue;
    const mid=(w.start+w.end)/2;if(mid<Number(c.start)||mid>=Number(c.end))continue;
    const text=tokens(w.text);if(!text.length)continue;
    const clock=at+(mid-Number(c.start))/speed;selectedWords++;
    const present=overlays.some(o=>clock>=Number(o.start)-.2&&clock<=Number(o.end)+.2&&text.every(t=>tokens(o.text).includes(t)));
    if(!present)missing.push({at:Math.round(clock*100)/100,text:w.text.trim()});
   }
  }
  at+=duration-(transitions.get(index)??0);
 }
 return {selectedWords,possibleMissingWords:missing.length,examples:missing.slice(0,80),scope:'word/time diagnostic; verify ASR and intentional burned-in text before repair'};
}

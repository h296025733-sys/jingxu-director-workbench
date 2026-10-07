/** Fixed renderer geometry; the model never supplies drawing code or file paths. */
export const EDIT_GRAPHICS_SCHEMA = {type:"array",maxItems:6,items:{type:"object",additionalProperties:false,properties:{
  kind:{type:"string",enum:["ring","arrow","bracket"]}, start:{type:"number",minimum:0},end:{type:"number",minimum:0},
  x:{type:"number",minimum:.05,maximum:.9},y:{type:"number",minimum:.08,maximum:.8},
  width:{type:"number",minimum:.04,maximum:.35},height:{type:"number",minimum:.04,maximum:.3},
  direction:{type:"string",enum:["left","right","up","down"]},
  evidence:{type:"string",minLength:8,maxLength:300},
},required:["kind","start","end","x","y","width","height","direction","evidence"]}} as const;

export function safeEditGraphics(raw:unknown): Record<string,unknown>[] {
  if(!Array.isArray(raw))return [];
  let until=-1;
  return raw.slice(0,6).filter(v=>v&&typeof v==='object').sort((a,b)=>Number(a.start)-Number(b.start)).filter(g=>{
    if(!['ring','arrow','bracket'].includes(g.kind)||!['left','right','up','down'].includes(g.direction)||typeof g.evidence!=='string'||g.evidence.length<8)return false;
    if(![g.start,g.end,g.x,g.y,g.width,g.height].every(Number.isFinite)||g.start<0||g.end-g.start<.3||g.end-g.start>3||g.start<until+.25)return false;
    if(g.x<.05||g.y<.08||g.width<.04||g.height<.04||g.width>.35||g.height>.3||g.x+g.width>.92||g.y+g.height>.84)return false;
    until=g.end;return true;
  });
}

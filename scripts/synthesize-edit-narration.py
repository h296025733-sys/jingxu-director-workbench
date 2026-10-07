"""Bounded local clone synthesis for approved, timed offscreen additions."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time

LAB=Path(os.environ.get("DW_AUTO_EDIT_LAB_ROOT", str(Path(__file__).resolve().parents[2] / "codex-auto-video-lab")))
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',OMP_NUM_THREADS='2',MKL_NUM_THREADS='2')
os.environ['PATH']=str(LAB/'tools/ffmpeg/bin')+os.pathsep+str(LAB/'venvs/cosyvoice3-py310/Library/bin')+os.pathsep+os.environ['PATH']
sys.path[:0]=[str(LAB/'vendor/CosyVoice'),str(LAB/'vendor/CosyVoice/third_party/Matcha-TTS')]
sys.modules['wetext']=None
DIRECTIONS={
 'neutral':'You are a helpful assistant.<|endofprompt|>',
 'excited':'You are a helpful assistant. 请用开心、自然、有活力的语气说话，不要喊叫。<|endofprompt|>',
 'emphatic':'You are a helpful assistant. 请用自信有力、充满热情的语气说话，重读重点词，不要喊叫。<|endofprompt|>'}

def resolve_builtin_profile(voices, profile_id, gender):
 registry_file=voices/'voice-profiles.json'
 if not registry_file.is_file():raise ValueError('Built-in voice registry unavailable')
 registry=json.loads(registry_file.read_text(encoding='utf8'))
 profile=next((item for item in registry.get('profiles',[]) if item.get('id')==profile_id),None)
 if not profile or profile.get('gender')!=gender:raise ValueError('Built-in voice profile is invalid')
 relative=Path(str(profile.get('reference','')))
 if relative.is_absolute() or '..' in relative.parts:raise ValueError('Built-in voice reference path is invalid')
 reference=(voices/relative).resolve()
 try:reference.relative_to(voices.resolve())
 except ValueError as error:raise ValueError('Built-in voice reference escaped its library') from error
 if not reference.is_file():raise ValueError('Built-in voice reference unavailable')
 digest=hashlib.sha256(reference.read_bytes()).hexdigest()
 if profile.get('referenceSha256')!=digest:raise ValueError('Built-in voice reference provenance changed')
 return profile,reference

def continuous_window_limit(data):
 return 90 if data.get('purpose')=='standalone_voice' and len(data.get('lines',[]))==1 else 30

def reference_method(data, reference_text, reference_language, has_reference):
 if has_reference and data['emotion']=='neutral' and reference_text:
  language_aware=data.get('purpose')=='standalone_voice' or data.get('voiceReferenceKind')=='personal'
  if language_aware and reference_language and reference_language!=data['language']:
   return 'reference_cross_lingual'
  return 'reference_zero_shot'
 return 'directed_instruct2'

def normalize_delivery(data):
 # Older web builds omit delivery for long AUTO narration. Validate the same
 # 30-second/500-character contract accepted by the planner before loading GPU.
 duration=float(data['duration'])
 if not math.isfinite(duration) or duration<=0:raise ValueError('Invalid video duration')
 if not isinstance(data.get('lines'),list) or not 1<=len(data['lines'])<=12:raise ValueError('Invalid narration line count')
 continuous=data.get('delivery')=='continuous'
 max_window=continuous_window_limit(data)
 intervals=[]
 for line in data['lines']:
  start=float(line['start']);end=float(line['end']);text=line['text']
  if not math.isfinite(start) or not math.isfinite(end) or start<0 or end>duration+.01 or not 2<=end-start<=max_window or not isinstance(text,str) or not text.strip() or not 0<len(text)<=500:
   raise ValueError('Invalid narration window or text')
  intervals.append((start,end))
  continuous=continuous or end-start>15 or len(text)>240
 intervals.sort()
 if any(b[0]<a[1] for a,b in zip(intervals,intervals[1:])):raise ValueError('Overlapping narration windows')
 if continuous:data['delivery']='continuous'
 return data

def main():
 p=argparse.ArgumentParser();p.add_argument('--request',type=Path,required=True);p.add_argument('--voices',type=Path,required=True);p.add_argument('--reference',type=Path);p.add_argument('--retry-indices',default='');p.add_argument('--validate-only',action='store_true');a=p.parse_args()
 request=a.request.resolve();data=json.loads(request.read_text(encoding='utf8'));out=request.parent/'narration';out.mkdir(exist_ok=True)
 if data['voice'] not in {'male','female'} or data['emotion'] not in DIRECTIONS or data['language'] not in {'en','es'} or len(data['lines'])>12:raise ValueError('Invalid narration request')
 data=normalize_delivery(data)
 profile_id=str(data.get('voiceProfile','')).strip()
 profile=None
 if a.reference:
  ref=a.reference.resolve()
 elif profile_id:
  profile,ref=resolve_builtin_profile(a.voices.resolve(),profile_id,data['voice'])
 else:
  # Historical tasks did not store a numbered profile. Preserve their exact
  # original male/female reference and instruct2 behavior on retry.
  ref=a.voices.resolve()/(data['voice']+'-reference.wav')
 if not ref.is_file():raise ValueError('Clone reference unavailable')
 reference_text='';reference_language=''
 if a.reference:
  reference_report=json.loads((ref.parent/'reference-report.json').read_text(encoding='utf8'))
  if reference_report.get('referenceSha256')!=hashlib.sha256(ref.read_bytes()).hexdigest():raise ValueError('Clone reference provenance changed')
  reference_text=str(reference_report.get('transcript','')).strip()
  reference_language=str(reference_report.get('detectedLanguage','')).strip().lower()
  if len(reference_text)<15:raise ValueError('Clone reference transcript too short')
 elif profile and data['emotion']=='neutral' and str(profile.get('transcript','')).strip():
  reference_text=str(profile['transcript']).strip()
  if len(reference_text)<15:raise ValueError('Built-in voice transcript too short')
 method=reference_method(data,reference_text,reference_language,bool(a.reference or profile))
 pace=float(data.get('pace',1.0))
 if not .8<=pace<=1.0 or (data.get('delivery')!='continuous' and pace!=1.0):raise ValueError('Invalid narration pace')
 retry={int(i) for i in a.retry_indices.split(',') if i.strip()}
 if any(i<0 or i>=len(data['lines']) for i in retry):raise ValueError('Invalid retry line index')
 previous=json.loads((request.parent/'narration-synthesis.json').read_text(encoding='utf8')) if retry else None
 if previous and (previous['referenceSha256']!=hashlib.sha256(ref.read_bytes()).hexdigest() or len(previous['lines'])!=len(data['lines'])):raise ValueError('Retry provenance changed')
 if previous and (previous['language']!=data['language'] or any(any(old.get(k)!=new.get(k) for k in ('start','end','text')) for i,(old,new) in enumerate(zip(previous['lines'],data['lines'])) if i not in retry)):raise ValueError('Retry changed a successful narration line')
 if a.validate_only:
  print(json.dumps({'valid':True,'voice':data['voice'],'voiceProfile':profile_id if profile else None,'emotion':data['emotion'],'language':data['language'],'cloneMethod':method,'referenceSha256':hashlib.sha256(ref.read_bytes()).hexdigest(),'lineCount':len(data['lines'])}))
  return
 import torch
 import numpy as np
 import soundfile as sf
 torch.set_num_threads(2);torch.set_num_interop_threads(2)
 if not torch.cuda.is_available() or torch.cuda.mem_get_info()[0]<2800*1048576:raise RuntimeError('GPU currently busy; other applications were not interrupted')
 from cosyvoice.cli.cosyvoice import AutoModel
 from cosyvoice.cli.model import CosyVoiceModel
 import onnxruntime
 native=onnxruntime.InferenceSession
 def session(file,*args,**kwargs):
  kwargs['providers']=['CPUExecutionProvider'];return native(file,*args,**kwargs)
 onnxruntime.InferenceSession=session
 def loader(self,llm_model,flow_model,hift_model):
  for name,file in [('llm',llm_model),('flow',flow_model),('hift',hift_model)]:
   weights=torch.load(file,map_location='cpu',weights_only=True,mmap=True)
   if name=='hift':weights={k.replace('generator.',''):v for k,v in weights.items()}
   mod=getattr(self,name);mod.load_state_dict(weights,strict=True);del weights
   if name!='hift':mod.half()
   mod.to(self.device).eval()
 CosyVoiceModel.load=loader
 model=AutoModel(model_dir=str(LAB/'models/Fun-CosyVoice3-0.5B-2512'),fp16=True)
 entries=[]
 for i,line in enumerate(data['lines']):
  if retry and i not in retry:
   entries.append(previous['lines'][i]);continue
  text=line['text'];slot=float(line['end'])-float(line['start'])
  # A continuous voiceover is synthesized as one performance so every visual
  # cut does not restart the speaker's prosody. Keep legacy sentence limits.
  if data.get('delivery') == 'continuous':
   if not 0<len(text)<=500 or not 2<=slot<=continuous_window_limit(data):raise ValueError('Invalid continuous narration duration')
  elif not 0<len(text)<=240 or not 2<=slot<=15:raise ValueError('Invalid line duration')
  line_pace=pace if data.get('delivery')=='continuous' and (slot>15 or len(text)>240) else 1.0
  accepted=False;durations=[]
  for attempt in range(1 if retry else 2):
   torch.manual_seed(20260908+i+attempt*100+(10000 if retry else 0))
   begin=time.monotonic()
   if method=='reference_cross_lingual':
    generation=model.inference_cross_lingual(DIRECTIONS['neutral']+text,str(ref),stream=False,speed=line_pace,text_frontend=False)
   elif method=='reference_zero_shot':
    generation=model.inference_zero_shot(text,DIRECTIONS['neutral']+reference_text,str(ref),stream=False,speed=line_pace,text_frontend=False)
   else:
    generation=model.inference_instruct2(text,DIRECTIONS[data['emotion']],str(ref),stream=False,speed=line_pace,text_frontend=False)
   chunks=[x['tts_speech'].cpu() for x in generation]
   samples=torch.cat(chunks,dim=1).squeeze(0).float().numpy() if chunks else np.array([])
   duration=len(samples)/model.sample_rate
   durations.append(duration)
   if len(samples) and np.isfinite(samples).all() and .3<duration<=slot-.12 and np.sqrt(np.mean(samples**2))>.001:
    file=out/f'line-{i}.wav';sf.write(file,samples,model.sample_rate,subtype='PCM_16');accepted=True
    entries.append({**line,'file':str(file),'seconds':duration,'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),'generationSeconds':time.monotonic()-begin,'asrRepairAttempt':bool(retry)});break
  if not accepted:entries.append({**line,'skipped':'Speech did not fit its picture window; no speed-up or picture retiming','attemptSeconds':durations,'asrRepairAttempt':bool(retry)})
  print(json.dumps({'line':i,'synthesized':accepted}),flush=True)
 report={'engine':'CosyVoice3','modelRevision':'29e01c4e8d000f4bcd70751be16fa94bf3d85a18','cloneMethod':method,'voiceProfile':profile_id if profile else None,'referenceSha256':hashlib.sha256(ref.read_bytes()).hexdigest(),'referencePath':str(ref) if a.reference else None,'voicesDirectory':str(a.voices.resolve()),'language':data['language'],'lines':entries,'listeningAccepted':False}
 (request.parent/'narration-synthesis.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
if __name__=='__main__':main()

"""ASR roundtrip, real clock captions and a timeline-length voice-only stem.
Does not modify original media or claim that ASR proves natural delivery.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time
import unicodedata

LAB=Path(os.environ.get("DW_AUTO_EDIT_LAB_ROOT", str(Path(__file__).resolve().parents[2] / "codex-auto-video-lab")))

def approved_brand_tokens(request):
 """Exact all-caps product tokens whose spoken letters may be ASR-separated."""
 approved=' '.join(str(line.get('text','')) for line in request.get('lines',[]))
 stop={'the','and','for','with'}
 return {token.lower() for token in re.findall(r'\b[A-Z][A-Z0-9]{2,14}\b',approved) if token.lower() not in stop}

def collapse_exact_brand_parts(values, approved_brands=None):
 """Accept OMU-CA / O M U C A only when the parts exactly rebuild STOREONE.

 This is deliberately not fuzzy matching: unrelated words and misspelled
 brands remain failures.
 """
 brands=set(approved_brands or ())
 if not brands:return values
 collapsed=[];index=0
 while index<len(values):
  match=None
  for end in range(min(len(values),index+8),index+1,-1):
   candidate=''.join(values[index:end])
   if candidate in brands:
    match=(candidate,end);break
  if match:
   collapsed.append(match[0]);index=match[1]
  else:
   collapsed.append(values[index]);index+=1
 return collapsed

def words(text, aliases=None, approved_brands=None):
 text=text.lower().replace('\u2019',"'")
 # Equivalent spoken contractions must not discard an otherwise correct take.
 # Preserve negation; do not normalize arbitrary possessive names or numbers.
 text=re.sub(r"\b(i)'m\b",r'\1 am',text)
 text=re.sub(r"\b(you|we|they)'re\b",r'\1 are',text)
 text=re.sub(r"\b(i|you|we|they)'ve\b",r'\1 have',text)
 text=re.sub(r"\b(it|that|there|here|what|who)'s\s+(?=been\b)",r'\1 has ',text)
 text=re.sub(r"\b(it|that|there|here|what|who)'s\b",r'\1 is',text)
 text=re.sub(r"\bmusic's\s+(?=playing\b)",'music is ',text)
 values=re.findall(r"[a-z0-9]+",unicodedata.normalize('NFKD',text.lower()).encode('ascii','ignore').decode())
 # These spellings have the same spoken form. Keep the approved text on screen;
 # an ASR spelling choice is not a missing/changed spoken product fact.
 base={'grille':'grill','grilles':'grills'}
 normalized=[(aliases or {}).get(value,base.get(value,value)) for value in values]
 return collapse_exact_brand_parts(normalized,approved_brands)

def contextual_character_count(text, following='', aliases=None):
 return len(''.join(words(text+' '+following,aliases)))-len(''.join(words(following,aliases)))

def bounded_spelling_aliases(request):
 """Opt-in near spelling for a known phonetic brand token; never facts/numbers."""
 raw=request.get('asrSpellingAliases',[])
 if not isinstance(raw,list) or len(raw)>4:raise ValueError('Invalid ASR spelling alias list')
 approved=' '.join(line.get('text','') for line in request.get('lines',[])).lower()
 aliases={}
 for item in raw:
  if not isinstance(item,dict):raise ValueError('Invalid ASR spelling alias')
  heard=item.get('heard','').lower();intended=item.get('intended','').lower()
  if not re.fullmatch(r'[a-z]{3,15}',heard) or not re.fullmatch(r'[a-z]{3,15}',intended) or heard==intended or heard[0]!=intended[0] or intended not in words(approved):
   raise ValueError('ASR alias must be a near spelling of an approved spoken token')
  distance=list(range(len(intended)+1))
  for i,char in enumerate(heard,1):
   next_row=[i]
   for j,target in enumerate(intended,1):next_row.append(min(next_row[-1]+1,distance[j]+1,distance[j-1]+(char!=target)))
   distance=next_row
  if distance[-1]>2:raise ValueError('ASR spelling alias too distant')
  aliases[heard]=intended
 return aliases

def phrase_groups(text):
 tokens=text.split();groups=[];current=[]
 for token in tokens:
  if current and (len(current)>=6 or len(' '.join(current+[token]))>36):
   groups.append(current);current=[]
  current.append(token)
  if len(current)>=3 and re.search(r'[.!?;:]$',token):groups.append(current);current=[]
 if current:groups.append(current)
 if len(groups)>1 and len(groups[-1])<3:
  if len(' '.join(groups[-2]+groups[-1]))<=40:groups[-2:]=[groups[-2]+groups[-1]]
  else:
   while len(groups[-1])<3 and len(groups[-2])>3:groups[-1].insert(0,groups[-2].pop())
 return groups

def prevent_caption_overlap(captions):
 for previous,current in zip(captions,captions[1:]):
  if previous['end']>current['start']:
   previous['end']=max(previous['start'],current['start'])
 return captions

def validate_ready_lines(request, ready):
 """Bind measured speech to the exact request, including partial deliveries."""
 requested=request.get('lines',[]);seen=set()
 for line in ready.get('lines',[]):
  index=line.get('requestIndex')
  if index is None:
   matches=[i for i,source in enumerate(requested) if all(source.get(k)==line.get(k) for k in ('start','end','text'))]
   if len(matches)!=1:raise ValueError('Ambiguous narration request binding')
   index=matches[0]
  if not isinstance(index,int) or isinstance(index,bool) or index<0 or index>=len(requested) or index in seen:raise ValueError('Invalid narration request index')
  source=requested[index]
  if any(source.get(k)!=line.get(k) for k in ('start','end','text')):raise ValueError('Stale narration does not match request')
  start=float(line['start']);seconds=float(line['seconds']);end=float(line['end'])
  if not all(math.isfinite(v) for v in (start,seconds,end)) or start<0 or seconds<=0 or start+seconds>end+.01 or end>float(request['duration'])+.01:raise ValueError('Invalid measured narration clock')
  seen.add(index)
 return {'requested':len(requested),'delivered':len(seen),'complete':bool(requested) and len(seen)==len(requested)}

def mark_retry_failure(report, indices, reason):
 for index in indices:
  report['lines'][index].pop('file',None)
  report['lines'][index]['skipped']=f'Bounded synthesis retry did not complete: {reason}'

def captions_for_line(line, segments, aliases=None):
 """Reject unusable timestamps per sentence, without losing other good takes."""
 timed=[word for segment in segments for word in (segment.words or [])]
 if not timed or any(not math.isfinite(w.start) or not math.isfinite(w.end) or w.start<0 or w.end<w.start or w.end>line['seconds']+.15 for w in timed):raise ValueError('Invalid word timestamps')
 if any(b.start<a.start for a,b in zip(timed,timed[1:])):raise ValueError('Unordered word timestamps')
 char_ends=[];count=0;cursor=0;captions=[]
 for index,w in enumerate(timed):
  count+=contextual_character_count(w.word,timed[index+1].word if index+1<len(timed) else '',aliases);char_ends.append(count)
 if count!=len(''.join(words(line['text'],aliases))):raise ValueError('Word timing does not cover approved narration')
 groups=phrase_groups(line['text'])
 for index,group in enumerate(groups):
  following=groups[index+1][0] if index+1<len(groups) else ''
  length=contextual_character_count(' '.join(group),following,aliases)
  if length<=0:raise ValueError('Caption group has no spoken words')
  first=next(j for j,n in enumerate(char_ends) if n>cursor);last=next(j for j,n in enumerate(char_ends) if n>=cursor+length)
  start=line['start']+timed[first].start;end=min(line['end'],line['start']+timed[last].end+.08)
  if end<=start:raise ValueError('Empty caption clock')
  captions.append({'kind':'caption','text':' '.join(group),'start':start,'end':end,'preset':'fine_caption','animation':'fade','effect_reason':'readability','highlights':[],'x':line.get('x',.48),'y':line.get('y',.76),'align':line.get('align',5),'layer':20,'color':'#FFFFFF','outline_color':'#101010'})
  cursor+=length
 return captions

def recognize_line(model,file,language,text,aliases,approved_brands=None):
 attempts=[]
 for use_vad in (True,False):
  segments,_=model.transcribe(str(file),language=language,beam_size=5,word_timestamps=True,vad_filter=use_vad,condition_on_previous_text=False)
  segments=list(segments);actual=' '.join(s.text for s in segments)
  exact=words(actual,approved_brands=approved_brands)==words(text,approved_brands=approved_brands)
  equivalent=words(actual,aliases,approved_brands)==words(text,aliases,approved_brands)
  attempts.append({'vad':use_vad,'recognized':actual,'aliasApplied':equivalent and not exact})
  # No forced transcript or fuzzy fact matching. A second segmentation can
  # recover a clipped opening syllable, but changed words still fail closed.
  if equivalent:return segments,attempts,True
 return segments,attempts,False

def main():
 started=time.monotonic()
 p=argparse.ArgumentParser();p.add_argument('--request',type=Path,required=True);a=p.parse_args();root=a.request.resolve().parent
 request=json.loads(a.request.read_text(encoding='utf8'));report=json.loads((root/'narration-synthesis.json').read_text(encoding='utf8'))
 aliases=bounded_spelling_aliases(request)
 brands=approved_brand_tokens(request)
 from faster_whisper import WhisperModel
 import numpy as np
 import soundfile as sf
 model=WhisperModel(str(LAB/'models/faster-whisper-small'),device='cpu',compute_type='int8',cpu_threads=2,num_workers=1)
 accurate_model=None;accurate_unavailable=False;fallback_errors=[]
 def recognize_with_fallback(file,language,text):
  nonlocal accurate_model,accurate_unavailable
  segments,attempts,matched=recognize_line(model,file,language,text,aliases,brands)
  attempts=[{**item,'model':'small'} for item in attempts]
  accurate_path=LAB/'models/faster-whisper-large-v3-turbo'
  if not matched and not accurate_unavailable and (accurate_path/'model.bin').is_file() and time.monotonic()-started<195:
   try:
    if accurate_model is None:
     accurate_model=WhisperModel(str(accurate_path),device='cpu',compute_type='int8',cpu_threads=2,num_workers=1)
    segments,extra,matched=recognize_line(accurate_model,file,language,text,aliases,brands)
    attempts.extend({**item,'model':'large-v3-turbo'} for item in extra)
   except (RuntimeError,OSError) as error:
    accurate_unavailable=True;fallback_errors.append(type(error).__name__)
  return segments,attempts,matched
 cache={};retry_indices=[];repair_history=[]
 for i,line in enumerate(report['lines']):
  if not line.get('file'):
   if str(line.get('skipped','')).startswith('Speech did not fit') and not line.get('asrRepairAttempt'):
    retry_indices.append(i);repair_history.append({'index':i,'reason':line['skipped']})
   continue
  file=Path(line['file']).resolve()
  if file.parent != (root/'narration').resolve() or hashlib.sha256(file.read_bytes()).hexdigest()!=line['sha256']:raise ValueError('Narration provenance mismatch')
  segments,attempts,matched=recognize_with_fallback(file,report['language'],line['text'])
  cache[i]=(segments,attempts,matched)
  if not matched and not line.get('asrRepairAttempt'):retry_indices.append(i);repair_history.append({'index':i,'sha256':line['sha256'],'attempts':attempts})
 # Keep every good sentence. Only actually mismatching sentences get one new
 # synthesis, in the existing serial voice permit and original five-minute cap.
 standalone=request.get('purpose')=='standalone_voice'
 retry_start_limit=420 if standalone else 180
 repair_deadline=540 if standalone else 240
 repair_maximum=300 if standalone else 180
 if retry_indices and report.get('voicesDirectory') and time.monotonic()-started<retry_start_limit:
  (root/'narration-asr-repair.json').write_text(json.dumps(repair_history,ensure_ascii=False,indent=2),encoding='utf8')
  try:
   reference_args=[]
   if report.get('referencePath'):
    reference=Path(report['referencePath']).resolve()
    if not reference.is_relative_to(root.resolve()) or hashlib.sha256(reference.read_bytes()).hexdigest()!=report['referenceSha256']:
     raise ValueError('Cloned voice reference provenance mismatch')
    reference_args=['--reference',str(reference)]
   subprocess.run([str(LAB/'venvs/cosyvoice3-py310/python.exe'),str(Path(__file__).with_name('synthesize-edit-narration.py')),'--request',str(a.request.resolve()),'--voices',report['voicesDirectory'],*reference_args,'--retry-indices',','.join(map(str,retry_indices))],check=True,timeout=min(repair_maximum,repair_deadline-(time.monotonic()-started)),cwd=str(LAB))
   report=json.loads((root/'narration-synthesis.json').read_text(encoding='utf8'))
   for i in retry_indices:
    line=report['lines'][i]
    if not line.get('file'):cache.pop(i,None);continue
    file=Path(line['file']).resolve()
    if file.parent != (root/'narration').resolve() or hashlib.sha256(file.read_bytes()).hexdigest()!=line['sha256']:raise ValueError('Narration repair provenance mismatch')
    cache[i]=recognize_with_fallback(file,report['language'],line['text'])
  except (subprocess.CalledProcessError,subprocess.TimeoutExpired) as error:
   # A partial retry may replace a WAV before it times out; never mix that
   # unverified file using an old timestamp or hash.
   mark_retry_failure(report,retry_indices,type(error).__name__)
   repair_history.append({'retryError':type(error).__name__})
 elif retry_indices:
  repair_history.append({'retrySkipped':'Time budget exhausted before re-synthesis','elapsedSeconds':round(time.monotonic()-started,2)})
 report['asrRepairHistory']=repair_history
 report['accurateRecognizerErrors']=fallback_errors
 sr=24000;mix=np.zeros(int(request['duration']*sr)+1,dtype='float32');captions=[];used=[]
 for i,line in enumerate(report['lines']):
  if not line.get('file'):continue
  file=Path(line['file']).resolve()
  if file.parent != (root/'narration').resolve() or hashlib.sha256(file.read_bytes()).hexdigest()!=line['sha256']:raise ValueError('Narration provenance mismatch')
  segments,attempts,matched=cache[i]
  line['demo_ef6b566c']=attempts
  if not matched:
   line['skipped']='ASR roundtrip did not match the approved words' + (' after bounded repair' if line.get('asrRepairAttempt') else '; no re-synthesis completed');line['recognized']=attempts[-1]['recognized'];continue
  line['asrSpellingAliasApplied']=bool(next((attempt.get('aliasApplied') for attempt in attempts if words(attempt['recognized'],aliases)==words(line['text'],aliases)),False))
  samples,rate=sf.read(file,dtype='float32');assert rate==sr and samples.ndim==1
  try:line_captions=captions_for_line(line,segments,aliases)
  except (ValueError,StopIteration,IndexError) as error:
   line['skipped']=f'Caption timing could not be verified: {type(error).__name__}';continue
  start=round(line['start']*sr)
  if start<0 or start+len(samples)>len(mix):
   line['skipped']='Measured speech exceeds the final timeline';continue
  mix[start:start+len(samples)]+=samples;captions.extend(line_captions)
  used.append({**line,'requestIndex':i})
 prevent_caption_overlap(captions)
 dest=root/'narration'/'voiceover.wav';sf.write(dest,mix,sr,subtype='PCM_16')
 subprocess.run([str(LAB/'tools/ffmpeg/bin/ffmpeg.exe'),'-v','error','-i',str(dest),'-f','null','-'],check=True,timeout=60)
 (root/'narration-ready.json').write_text(json.dumps({'lines':used,'captions':captions,'source':str(dest),'asrRoundtrip':True,'asrSpellingAliasAccepted':any(line.get('asrSpellingAliasApplied') for line in used),'listeningAccepted':False,'diagnostics':report},ensure_ascii=False,indent=2),encoding='utf8')
if __name__=='__main__':main()

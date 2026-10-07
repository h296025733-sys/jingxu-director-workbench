"""Pre-rendered black showroom using the SAME native v2 renderer as edits."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from auto_video_lab.paths import JobPaths
from auto_video_lab.render import build_render_command
from auto_video_lab.plan import validate_plan

VERSION=int(sys.argv[1]) if len(sys.argv)>1 else 2
assert VERSION in (2,3)
SITE=Path(__file__).resolve().parents[1];ROOT=SITE/f'data/voice-templates/v{VERSION}';LAB=Path(os.environ.get("DW_AUTO_EDIT_LAB_ROOT", str(Path(__file__).resolve().parents[2] / "codex-auto-video-lab")));FF=LAB/'tools/ffmpeg/bin/ffmpeg.exe'
job=JobPaths.for_id(f'mx-showroom-v{VERSION}-20260908');job.ensure()
def run(args,cwd=job.root):
 subprocess.run([str(x) for x in args],cwd=cwd,check=True,timeout=120,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
black=job.inputs/'black.mp4'
if not black.exists():run([FF,'-v','error','-f','lavfi','-i','color=black:s=540x960:r=30:d=12','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','12','-c:v','libx264','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-y',black])
out=ROOT/'previews';out.mkdir(exist_ok=True);posters=SITE/f'public/edit-previews/v{VERSION}';posters.mkdir(parents=True,exist_ok=True)
results=[]
for item in json.loads((ROOT/'showroom-input.json').read_text(encoding='utf8'))['clips']:
 name=item['name'];voice=job.inputs/item['voice'];shutil.copy2(SITE/'data/voice-templates/v1/auditions'/item['voice'],voice)
 plan={'schema_version':1,'job_id':job.root.name,'output':{'filename':name+'.mp4','width':540,'height':960,'fps':30,'video_codec':'libx264','preset':'fast','crf':22,'audio_bitrate':'96k'},'clips':[{'kind':'video','source':'inputs/black.mp4','start':0,'end':item['seconds'],'speed':1,'fit':'contain','mute':True,'audio_gain_db':0}],'overlays':item['overlays'],'presentation':item['presentation'],'music':None,'voiceover':{'source':'inputs/'+voice.name,'start':.35,'volume_db':0},'finishing':{'preset':'none'},'sfx':[]}
 (job.root/(name+'.json')).write_text(json.dumps(plan),encoding='utf8')
 checked=validate_plan(job.root.name,plan)['plan'];args,dest,_=build_render_command(job,checked)
 run(args);run([FF,'-v','error','-i',dest,'-f','null','-']);shutil.copy2(dest,out/dest.name)
 if name.endswith('female-neutral'):
  poster=posters/('-'.join(name.split('-')[:2])+'.jpg');run([FF,'-v','error','-y','-ss','1','-i',dest,'-frames:v','1',poster])
 results.append({'name':dest.name,'sha256':hashlib.sha256(dest.read_bytes()).hexdigest(),'bytes':dest.stat().st_size,'completeDecode':True})
 print(name,flush=True)
(out/'manifest.json').write_text(json.dumps({'version':VERSION,'scope':'synthetic black-screen style previews; existing actual clone audio; not real footage selection','files':results},indent=2),encoding='utf8')

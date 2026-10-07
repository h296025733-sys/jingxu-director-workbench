"""Synthetic sample copy + stock TTS + the production caption renderer, prepared offline.

Rate/pitch variations are previews of delivery, not a claim of emotion cloning.
No employee voice or file is read and no production task is created.
"""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import edge_tts
from auto_video_lab.render import write_ass, _verified_fine_cut_font_files

FFMPEG = Path(os.environ.get("DW_AUTO_EDIT_LAB_ROOT", str(Path(__file__).resolve().parents[2] / "codex-auto-video-lab"))) / "tools/ffmpeg/bin/ffmpeg.exe"
FFPROBE = FFMPEG.with_name('ffprobe.exe')
VOICES = {'en': {'female': 'en-US-JennyNeural', 'male': 'en-US-GuyNeural'},
          'es': {'female': 'es-MX-DaliaNeural', 'male': 'es-MX-JorgeNeural'}}
DELIVERY = {'neutral': ('+0%', '+0Hz'), 'excited': ('+12%', '+4Hz'), 'emphatic': ('-5%', '-2Hz')}


def run(args, cwd):
    subprocess.run([str(FFMPEG), '-hide_banner', '-loglevel', 'error', '-y', *args], cwd=cwd, check=True, timeout=180)


def duration(file):
    return float(subprocess.check_output([str(FFPROBE), '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(file)], text=True).strip())


async def main():
    input_path, output = map(Path, sys.argv[1:3])
    spec = json.loads(input_path.read_text(encoding='utf8'))
    work = input_path.parent
    output.mkdir(parents=True, exist_ok=True)
    fonts = work / 'fonts'
    fonts.mkdir(exist_ok=True)
    for file in _verified_fine_cut_font_files():
        shutil.copy2(file, fonts / file.name)
    limiter = asyncio.Semaphore(2)

    async def speak(text, voice, rate, pitch):
        key = hashlib.sha256(json.dumps([text, voice, rate, pitch]).encode()).hexdigest()[:20]
        target = work / f'voice-{key}.mp3'
        if target.exists() and target.stat().st_size > 1024:
            return target
        async with limiter:
            for attempt in range(3):
                try:
                    await asyncio.wait_for(edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).save(str(target)), timeout=35)
                    return target
                except Exception:
                    target.unlink(missing_ok=True)
                    if attempt == 2:
                        raise
                    await asyncio.sleep(attempt + 1)

    async def voice_track(language, gender, emotion):
        rate, pitch = DELIVERY[emotion]
        chunks = await asyncio.gather(*(speak(text, VOICES[language][gender], rate, pitch) for text in spec['languages'][language]))
        args, filters = [], []
        for i, file in enumerate(chunks):
            if duration(file) > 3.1:
                raise ValueError(f'Sample line too long for its fixed preview slot: {file.name}')
            args += ['-i', str(file)]
            filters.append(f'[{i}:a]adelay={350 + i * 3300}:all=1[a{i}]')
        filters.append('[a0][a1][a2]amix=inputs=3:normalize=0,apad,atrim=duration=9.9,loudnorm=I=-16:TP=-1.5:LRA=9[out]')
        audio = work / f'{language}-{gender}-{emotion}.m4a'
        run([*args, '-filter_complex', ';'.join(filters), '-map', '[out]', '-c:a', 'aac', '-b:a', '96k', '-threads', '2', str(audio)], work)
        return (language, gender, emotion, audio)

    tracks = await asyncio.gather(*(voice_track(language, gender, emotion) for language in VOICES for gender in VOICES[language] for emotion in DELIVERY))
    manifest = {'version': spec['version'], 'kind': 'synthetic_template_preview', 'voiceSource': 'stock_tts', 'productionDubbingEnabled': False,
                'emotionLimit': 'Rate/pitch demonstration only; not trained emotional voice or cloning.', 'files': []}
    for clip in spec['clips']:
        name = f"{clip['id']}-{clip['language']}"
        ass = work / f'{name}.ass'
        write_ass(clip['overlays'], ass, 432, 768)
        base = work / f'{name}.mp4'
        run(['-f', 'lavfi', '-i', 'color=c=black:s=432x768:r=30:d=9.9', '-vf', f'ass={ass.name}:fontsdir=fonts', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p', '-threads', '2', str(base)], work)
        run(['-ss', '1.1', '-i', str(base), '-frames:v', '1', '-update', '1', str(output / f'{name}.jpg')], work)
        for language, gender, emotion, audio in tracks:
            if language != clip['language']:
                continue
            file = output / f'{name}-{gender}-{emotion}.mp4'
            run(['-i', str(base), '-i', str(audio), '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-t', '9.9', '-movflags', '+faststart', str(file)], work)
            # A complete decode is a technical check, not an aesthetic or real-employee edit test.
            run(['-i', str(file), '-f', 'null', '-'], work)
            manifest['files'].append({'name': file.name, 'bytes': file.stat().st_size, 'duration': duration(file), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest()})
        print(f"Rendered and decoded {name}: 6 voice/delivery combinations", flush=True)
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps({'previews': len(manifest['files']), 'bytes': sum(file['bytes'] for file in manifest['files'])}), flush=True)


if __name__ == '__main__':
    asyncio.run(main())

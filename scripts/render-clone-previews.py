"""Render authenticated black-screen template auditions using measured word times."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

from auto_video_lab.render import write_ass, _verified_fine_cut_font_files
from check_clone_preview_words import normalized_words

LAB = Path(os.environ.get("DW_AUTO_EDIT_LAB_ROOT", str(Path(__file__).resolve().parents[2] / "codex-auto-video-lab")))
FFMPEG = LAB / 'tools/ffmpeg/bin/ffmpeg.exe'


def run(args, cwd):
    subprocess.run([str(FFMPEG), '-v', 'error', '-nostdin', '-y', *args], cwd=cwd, check=True, timeout=120)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--templates', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    manifest = json.loads((root / 'audition-manifest.json').read_text(encoding='utf8'))
    qa = json.loads((root / 'audition-qa.json').read_text(encoding='utf8'))
    templates = json.loads(args.templates.read_text(encoding='utf8'))
    work, output = root / 'preview-work', root / 'previews'
    work.mkdir(exist_ok=True)
    output.mkdir(exist_ok=True)
    fonts = work / 'fonts'
    fonts.mkdir(exist_ok=True)
    for file in _verified_fine_cut_font_files():
        shutil.copy2(file, fonts / file.name)
    result = {'kind': 'cloned_voice_template_audition', 'version': 1, 'productionDubbingEnabled': False, 'files': []}
    assert len(manifest['files']) == 12
    for item in manifest['files']:
        audio = root / 'auditions' / item['name']
        checked = next(entry for entry in qa['files'] if entry['name'] == item['name'])
        assert checked['sha256'] == item['sha256'] == hashlib.sha256(audio.read_bytes()).hexdigest()
        assert checked['exactWords'] or checked.get('spacingEquivalent'), f"A new audition or manual review is needed: {item['name']}"
        measured = checked['words']
        character_ends, total = [], 0
        for word in measured:
            total += len(''.join(normalized_words(word['text'])))
            character_ends.append(total)
        assert ''.join(normalized_words(item['text'])) == ''.join(normalized_words(' '.join(word['text'] for word in measured)))
        for clip in templates['clips']:
            if clip['language'] != item['language']:
                continue
            name = f"{clip['id']}-{item['language']}-{item['voice']}-{item['emotion']}"
            overlays = copy.deepcopy(clip['overlays'])
            if item['language'] == 'es':
                for overlay, text in zip(overlays, ['Mira la diferencia.', 'Destaca lo importante.', 'Cada palabra cuenta.']):
                    overlay['text'] = text
            cursor = 0
            duration = item['seconds'] + 0.8
            for index, overlay in enumerate(overlays):
                count = len(''.join(normalized_words(overlay['text'])))
                first = next(i for i, end in enumerate(character_ends) if end > cursor)
                last = next(i for i, end in enumerate(character_ends) if end >= cursor + count)
                start = measured[first]['start'] + 0.3
                end = measured[last]['end'] + 0.3
                next_start = measured[last + 1]['start'] + 0.3 if last + 1 < len(measured) else duration
                overlay['start'] = max(0, start - 0.05)
                overlay['end'] = min(next_start, max(start + 0.35, end + 0.13))
                cursor += count
            ass = work / f'{name}.ass'
            write_ass(overlays, ass, 432, 768)
            dest = output / f'{name}.mp4'
            pending = work / f'{name}.mp4'
            run(['-f', 'lavfi', '-i', f'color=c=black:s=432x768:r=30:d={duration:.3f}', '-i', str(audio), '-vf', f'ass={ass.name}:fontsdir=fonts', '-af', 'adelay=300:all=1,apad,loudnorm=I=-16:TP=-1.5:LRA=9', '-t', str(duration), '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p', '-threads', '2', '-filter_threads', '2', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', str(pending)], work)
            run(['-i', str(pending), '-f', 'null', '-'], work)
            pending.replace(dest)
            result['files'].append({'name': dest.name, 'sha256': hashlib.sha256(dest.read_bytes()).hexdigest(), 'bytes': dest.stat().st_size, 'seconds': duration, 'voiceSha256': item['sha256'], 'completeDecode': True})
        print(f"Rendered four subtitle templates: {item['name']}", flush=True)
    assert len(result['files']) == 48
    (output / 'manifest.json').write_text(json.dumps(result, indent=2), encoding='utf8')


if __name__ == '__main__':
    main()

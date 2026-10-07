"""Select a traceable, continuous speech sample from uploaded audio or video.

The source is read only. The output stays inside this one edit job and is never
published as a template or mixed into the finished video.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys

LAB = Path(os.environ.get("DW_AUTO_EDIT_LAB_ROOT", str(Path(__file__).resolve().parents[2] / "codex-auto-video-lab")))
FFMPEG = LAB / 'tools/ffmpeg/bin/ffmpeg.exe'
FFPROBE = FFMPEG.with_name('ffprobe.exe')


class VoiceReferenceError(Exception):
    pass


def run(args, timeout):
    return subprocess.run(args, check=True, timeout=timeout, capture_output=True,
                          text=True, encoding='utf-8', errors='replace')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    probe = json.loads(run([str(FFPROBE), '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(source)], 30).stdout)
    if not any(stream.get('codec_type') == 'audio' for stream in probe.get('streams', [])):
        raise VoiceReferenceError('音源文件没有可读取的音轨，请换一个有人声的音频或视频')
    duration = float(probe.get('format', {}).get('duration') or 0)
    if duration < 4:
        raise VoiceReferenceError('音源文件太短，请提供至少4秒连续清晰说话')
    extracted = output / 'source-first-180s.wav'
    run([str(FFMPEG), '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
         '-threads', '2', '-i', str(source), '-t', '180', '-map', '0:a:0', '-vn',
         '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', str(extracted)], 240)
    from faster_whisper import WhisperModel
    import numpy as np
    import soundfile as sf
    model = WhisperModel(str(LAB / 'models/faster-whisper-small'), device='cpu',
                         compute_type='int8', cpu_threads=2, num_workers=1, local_files_only=True)
    segments, info = model.transcribe(str(extracted), beam_size=3, word_timestamps=True,
                                      vad_filter=True, condition_on_previous_text=False)
    speech = []
    for segment in segments:
        if segment.no_speech_prob > .55 or segment.avg_logprob < -.9:
            continue
        for word in segment.words or []:
            if word.start is not None and word.end is not None and word.word.strip():
                speech.append({'start': float(word.start), 'end': float(word.end),
                               'text': word.word.strip(), 'probability': float(word.probability or 0)})
    if len(speech) < 7:
        raise VoiceReferenceError('音源里没识别到足够的清晰连续人声，请换一个单人清晰说话的音频或视频')
    candidates = []
    for first in range(len(speech)):
        for last in range(first + 6, min(first + 29, len(speech))):
            words = speech[first:last + 1]
            span = words[-1]['end'] - words[0]['start']
            if span > 10.5:
                break
            if span < 4.0 or any(words[i + 1]['start'] - words[i]['end'] > 1.25 for i in range(len(words) - 1)):
                continue
            mean_prob = sum(word['probability'] for word in words) / len(words)
            if mean_prob < .45:
                continue
            score = mean_prob * 4 - abs(span - 7.5) * .14 + min(len(words), 18) * .025
            candidates.append((score, words[0]['start'], words[-1]['end'], words))
    if not candidates:
        raise VoiceReferenceError('音源没有4–10秒连续且可辨认的口播，请换一个声音更清晰的音频或视频')
    score, begin, end, words = max(candidates, key=lambda item: item[0])
    begin = max(0, begin - .12)
    end = min(duration, end + .2)
    reference = output / 'reference.wav'
    run([str(FFMPEG), '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
         '-ss', f'{begin:.3f}', '-i', str(extracted), '-t', f'{end-begin:.3f}',
         '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', str(reference)], 60)
    samples, rate = sf.read(str(reference), dtype='float32')
    rms = math.sqrt(float(np.mean(samples ** 2))) if len(samples) else 0
    clipping = float(np.mean(np.abs(samples) >= .995)) if len(samples) else 1
    if len(samples) < rate * 3.8 or rms < .008 or clipping > .03:
        raise VoiceReferenceError('选出的说话片段过短、过轻或削波，请换一个录音更清楚的音频或视频')
    report = {
        'sourceSha256': hashlib.file_digest(source.open('rb'), 'sha256').hexdigest(),
        'referenceSha256': hashlib.file_digest(reference.open('rb'), 'sha256').hexdigest(),
        'sourceDurationSeconds': duration,
        'selectedStart': round(begin, 3), 'selectedEnd': round(end, 3),
        'transcript': ' '.join(word['text'] for word in words),
        'detectedLanguage': info.language, 'wordCount': len(words),
        'rms': round(rms, 5), 'clippingFraction': round(clipping, 5),
        'selectionScore': round(score, 5),
        'caveat': 'ASR and signal checks cannot prove one speaker, no music, or perceptual voice similarity.',
    }
    (output / 'reference-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf8')
    print(json.dumps({'reference': str(reference), 'start': begin, 'end': end,
                      'wordCount': len(words), 'detectedLanguage': info.language}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    try:
        main()
    except VoiceReferenceError as error:
        print('VOICE_REFERENCE_ERROR:' + str(error), file=sys.stderr, flush=True)
        sys.exit(2)

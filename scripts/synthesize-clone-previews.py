"""Offline, bounded CosyVoice3 auditions from the supplied private voice references.

This is a real zero-shot speaker-conditioned synthesis, not stock TTS or a pitch
effect. Emotion instructions are requested controls, not a quality guarantee.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time

LAB = Path(os.environ.get("DW_AUTO_EDIT_LAB_ROOT", str(Path(__file__).resolve().parents[2] / "codex-auto-video-lab")))
VENDOR = LAB / 'vendor/CosyVoice'
os.environ.setdefault('HF_HUB_OFFLINE', '1')
os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
os.environ.setdefault('OMP_NUM_THREADS', '2')
os.environ.setdefault('MKL_NUM_THREADS', '2')
os.environ['PATH'] = str(LAB / 'tools/ffmpeg/bin') + os.pathsep + str(LAB / 'venvs/cosyvoice3-py310/Library/bin') + os.pathsep + os.environ['PATH']
sys.path[:0] = [str(VENDOR), str(VENDOR / 'third_party/Matcha-TTS')]
# Samples already contain normalized words. Prevent the optional normalizer from
# attempting an unrelated model download during frontend construction.
sys.modules['wetext'] = None

COPY = {
    'en': 'See the difference. Focus on what matters. Make every word count.',
    'es': 'Mira la diferencia. Destaca lo importante. Cada palabra cuenta.',
}
DIRECTIONS = {
    'neutral': 'You are a helpful assistant.<|endofprompt|>',
    'excited': 'You are a helpful assistant. 请非常开心地说一句话。<|endofprompt|>',
    'emphatic': 'You are a helpful assistant. 请用自信有力、充满热情的语气说话，重读重点词，不要喊叫。<|endofprompt|>',
}
REFERENCES = {
    'female': {'source': 'source-1', 'start': 15.12, 'end': 21.64},
    'male': {'source': 'source-2', 'start': 0.0, 'end': 11.86},
}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--limit', type=int, default=12)
    parser.add_argument('--language', choices=['en', 'es'])
    parser.add_argument('--voice', choices=list(REFERENCES))
    parser.add_argument('--emotion', choices=list(DIRECTIONS))
    parser.add_argument('--seed', type=int, default=20260908)
    parser.add_argument('--retry-existing', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    output = root / 'auditions'
    output.mkdir(exist_ok=True)
    import torch
    import soundfile as sf
    import numpy as np
    torch.set_num_threads(2)
    torch.set_num_interop_threads(2)
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA unavailable; do not silently start unbounded CPU synthesis on the shared workstation')
    free, total = torch.cuda.mem_get_info()
    print(json.dumps({'stage': 'initializing', 'gpuFreeMiB': free // 1048576}), flush=True)
    if free < 2800 * 1048576:
        raise RuntimeError('Not enough free GPU memory for this local voice audition; existing applications were not stopped')
    from cosyvoice.cli.cosyvoice import AutoModel
    from cosyvoice.cli.model import CosyVoiceModel
    import onnxruntime
    native_session = onnxruntime.InferenceSession

    def cpu_reference_session(file, *positional, **kwargs):
        # Only short reference encoding runs here. Keep its ~1GB tokenizer off
        # the 6GB display GPU; the actual speech generator still uses CUDA.
        kwargs['providers'] = ['CPUExecutionProvider']
        return native_session(file, *positional, **kwargs)

    onnxruntime.InferenceSession = cpu_reference_session

    # The official loader temporarily holds duplicate FP32 weights on the GPU.
    # Load one checkpoint at a time on CPU, then transfer FP16 LLM/flow. Keep the
    # vocoder FP32. This adapter is process-local; the vendor package is unchanged.
    def memory_bounded_load(self, llm_model, flow_model, hift_model):
        for name, file in [('llm', llm_model), ('flow', flow_model), ('hift', hift_model)]:
            weights = torch.load(file, map_location='cpu', weights_only=True, mmap=True)
            if name == 'hift':
                weights = {k.replace('generator.', ''): v for k, v in weights.items()}
            module = getattr(self, name)
            module.load_state_dict(weights, strict=True)
            del weights
            if name != 'hift':
                module.half()
            module.to(self.device).eval()
    CosyVoiceModel.load = memory_bounded_load
    started = time.monotonic()
    model = AutoModel(model_dir=str(LAB / 'models/Fun-CosyVoice3-0.5B-2512'), fp16=True)
    print(json.dumps({'stage': 'model_ready', 'seconds': round(time.monotonic() - started, 2)}), flush=True)
    manifest_file = root / 'audition-manifest.json'
    manifest = json.loads(manifest_file.read_text(encoding='utf8')) if manifest_file.exists() else {
        'version': 1, 'engine': 'CosyVoice3', 'model': 'Fun-CosyVoice3-0.5B-2512',
        'modelRevision': '29e01c4e8d000f4bcd70751be16fa94bf3d85a18',
        'kind': 'speaker_conditioned_synthetic_audition', 'productionEnabled': False,
        'speakerMapping': REFERENCES, 'files': [],
    }
    completed = 0
    for voice, source in REFERENCES.items():
        if args.voice and args.voice != voice:
            continue
        reference = root / (voice + '-reference.wav')
        if not reference.exists():
            subprocess.run([str(LAB / 'tools/ffmpeg/bin/ffmpeg.exe'), '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', str(source['start']), '-i', str(root / (source['source'] + '.wav')), '-t', str(source['end'] - source['start']), '-af', 'highpass=f=65,afade=t=in:d=0.015', '-ar', '24000', '-ac', '1', str(reference)], check=True, timeout=60)
        for language, text in COPY.items():
            if args.language and language != args.language:
                continue
            for emotion, direction in DIRECTIONS.items():
                if args.emotion and args.emotion != emotion:
                    continue
                name = f'{voice}-{language}-{emotion}.wav'
                dest = output / name
                if not args.retry_existing and any(f['name'] == name and f['sha256'] == hashlib.sha256(dest.read_bytes()).hexdigest() for f in manifest['files'] if dest.exists()):
                    continue
                torch.manual_seed(args.seed)
                begin = time.monotonic()
                chunks = [chunk['tts_speech'].cpu() for chunk in model.inference_instruct2(text, direction, str(reference), stream=False, text_frontend=False)]
                if not chunks:
                    raise RuntimeError('Synthesis returned no audio')
                samples = torch.cat(chunks, dim=1).squeeze(0).float().numpy()
                duration = samples.size / model.sample_rate
                if not np.isfinite(samples).all() or not 2 <= duration <= 25 or float(np.sqrt(np.mean(samples ** 2))) < 0.001:
                    raise RuntimeError(f'Invalid audio samples for {name}')
                temp = dest.with_suffix('.pending.wav')
                sf.write(str(temp), samples, model.sample_rate, subtype='PCM_16')
                if dest.exists():
                    archive = root / 'previous-auditions'
                    archive.mkdir(exist_ok=True)
                    import shutil
                    shutil.copy2(dest, archive / (dest.stem + '-' + hashlib.sha256(dest.read_bytes()).hexdigest()[:12] + '.wav'))
                temp.replace(dest)
                entry = {'name': name, 'voice': voice, 'language': language, 'emotion': emotion, 'requestedDirection': direction, 'text': text, 'seconds': duration, 'generationSeconds': round(time.monotonic() - begin, 2), 'sampleRate': model.sample_rate, 'peak': float(np.max(np.abs(samples))), 'sha256': hashlib.sha256(dest.read_bytes()).hexdigest(), 'referenceSha256': hashlib.sha256(reference.read_bytes()).hexdigest(), 'transcriptionChecked': False, 'listeningAccepted': False}
                entry['seed'] = args.seed
                manifest['files'] = [item for item in manifest['files'] if item['name'] != name] + [entry]
                tmp = manifest_file.with_suffix('.pending.json')
                tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf8')
                tmp.replace(manifest_file)
                print(json.dumps({'stage': 'generated', **entry}, ensure_ascii=False), flush=True)
                completed += 1
                if completed >= args.limit:
                    return


if __name__ == '__main__':
    main()

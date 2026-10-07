import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { PREVIEW_VOICES } from '../lib/edit-templates.ts';

const root = path.resolve('data/voice-templates/v1');

test('every selectable built-in voice has a private hash-locked reference', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(root, 'voice-profiles.json'), 'utf8'));
  assert.deepEqual(registry.profiles.map((profile) => profile.id), PREVIEW_VOICES.map((voice) => voice.id));
  for (const profile of registry.profiles) {
    const reference = path.resolve(root, profile.reference);
    assert.equal(path.relative(root, reference).startsWith('..'), false, profile.id);
    assert.equal(fs.statSync(reference).isFile(), true, profile.id);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(reference)).digest('hex');
    assert.equal(digest, profile.referenceSha256, profile.id);
    assert.equal(profile.gender, PREVIEW_VOICES.find((voice) => voice.id === profile.id).gender);
  }
});

test('every selectable built-in voice has a private short audition', () => {
  for (const voice of PREVIEW_VOICES) {
    const audition = path.join(root, 'profile-auditions', `voice-${voice.id}.wav`);
    assert.equal(fs.existsSync(audition), true, voice.id);
    assert.ok(fs.statSync(audition).size > 10_000, voice.id);
  }
});

test('the production synthesizer resolves every numbered profile without loading the model', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-sequence-voices-'));
  try {
    for (const voice of PREVIEW_VOICES) {
      const request = path.join(folder, `${voice.id}.json`);
      fs.writeFileSync(request, JSON.stringify({
        voice: voice.gender,
        voiceProfile: voice.id,
        emotion: 'neutral',
        language: 'en',
        duration: 8,
        lines: [{ start: 0.5, end: 5.5, text: 'A short production validation line.', evidence: 'isolated test' }],
      }));
      const result = spawnSync(
        'D:/workspace/codex-auto-video-lab/venvs/cosyvoice3-py310/python.exe',
        ['scripts/synthesize-edit-narration.py','--request',request,'--voices',root,'--validate-only'],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, `${voice.id}: ${result.stderr}`);
      const output = JSON.parse(result.stdout.trim());
      assert.equal(output.valid, true);
      assert.equal(output.voiceProfile, voice.id);
      assert.equal(output.voice, voice.gender);
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

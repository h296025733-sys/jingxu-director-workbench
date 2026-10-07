import test from 'node:test';
import assert from 'node:assert/strict';
import { isClonePreviewName, isVoiceAuditionName } from '../lib/clone-preview-files.ts';

test('exactly 48 intended voice showroom combinations are addressable', () => {
  for (const t of ['clear','focus','social','impact']) for (const l of ['en','es'])
    for (const v of ['female','male']) for (const e of ['neutral','excited','emphatic'])
      assert.equal(isClonePreviewName(`${t}-${l}-${v}-${e}.mp4`), true);
});

test('only the seven numbered built-in voice auditions are addressable', () => {
  for (const name of ['voice-female-1.wav','voice-female-2.wav','voice-female-3.wav','voice-female-4.wav','voice-male-1.wav','voice-male-2.wav','voice-male-3.wav'])
    assert.equal(isVoiceAuditionName(name), true, name);
  for (const name of ['voice-female.wav','voice-female-5.wav','voice-male-4.wav','voice-female-1.mp3','../voice-female-1.wav','VOICE-female-1.wav'])
    assert.equal(isVoiceAuditionName(name), false, name);
});

test('references, arbitrary files, unknown templates and traversal cannot be exposed', () => {
  for (const name of ['../source-1.wav','female-reference.wav','source-evidence.json','audition-manifest.json','clear-zh-female-neutral.mp4','clear-en-other-neutral.mp4','clear-en-female-angry.mp4','clear-en-female-neutral.mp4.exe','clear-en-female-neutral.mp4/../x','CLEAR-en-female-neutral.mp4',''])
    assert.equal(isClonePreviewName(name), false, name);
});

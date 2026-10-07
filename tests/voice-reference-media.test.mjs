import assert from "node:assert/strict";
import test from "node:test";

import {
  detectVideoExt,
  detectVoiceReferenceExt,
  mimeForExt,
} from "../lib/storage.ts";

test("standalone voice-reference audio is detected from bytes, not a renamed suffix", () => {
  const wav = Buffer.from("RIFF\x24\x00\x00\x00WAVEfmt ", "latin1");
  const flac = Buffer.from("fLaC\x00\x00\x00\x22", "latin1");
  const ogg = Buffer.from("OggS\x00\x02voice", "latin1");
  const mp3 = Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1");
  const fake = Buffer.from("not audio even when named voice.wav", "utf8");

  assert.equal(detectVideoExt(wav), null);
  assert.equal(detectVoiceReferenceExt(wav, "voice.wav"), ".wav");
  assert.equal(detectVoiceReferenceExt(flac, "voice.flac"), ".flac");
  assert.equal(detectVoiceReferenceExt(ogg, "voice.opus"), ".opus");
  assert.equal(detectVoiceReferenceExt(mp3, "voice.mp3"), ".mp3");
  assert.equal(detectVoiceReferenceExt(fake, "voice.wav"), null);
});

test("shared containers retain a safe audio identity for voice-reference uploads", () => {
  const isoBmff = Buffer.alloc(24);
  isoBmff.write("ftyp", 4, "latin1");
  assert.equal(detectVoiceReferenceExt(isoBmff, "sample.m4a"), ".m4a");
  assert.equal(detectVoiceReferenceExt(isoBmff, "sample.mp4"), ".mp4");
  assert.equal(mimeForExt(".m4a"), "audio/mp4");
  assert.equal(mimeForExt(".wav"), "audio/wav");
});

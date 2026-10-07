import assert from "node:assert/strict";
import test from "node:test";
import { parseAutoEditQualityMetrics } from "../lib/auto-edit-quality-metrics.ts";

function valid(overrides = {}) {
  return {
    audioPresent: true, displayRotationDegrees: 0, blackBorderRatio: 0.01,
    openingFreezeSeconds: 0.1, openingMotionScore: 0.04,
    renderedDuplicates: [{ firstSeconds: 1, secondSeconds: 6, similarity: 0.99 }],
    audioCuts: [{ atSeconds: 3, beforeRmsDb: -20, afterRmsDb: -18, normalizedSampleJump: 0.1 }],
    ...overrides,
  };
}

test("严格测量解析器接受完整合法结果", () => {
  assert.deepEqual(parseAutoEditQualityMetrics(valid(), { durationSeconds: 10 }), valid());
});

test("空对象、缺字段、多字段与非有限数被拒绝", () => {
  assert.throws(() => parseAutoEditQualityMetrics({}), /字段/u);
  const missing = valid(); delete missing.openingMotionScore;
  assert.throws(() => parseAutoEditQualityMetrics(missing), /字段/u);
  assert.throws(() => parseAutoEditQualityMetrics({ ...valid(), extra: true }), /字段/u);
  assert.throws(() => parseAutoEditQualityMetrics(valid({ blackBorderRatio: Number.NaN })), /范围/u);
});

test("数值、时间顺序和成片边界严格校验", () => {
  assert.throws(() => parseAutoEditQualityMetrics(valid({ blackBorderRatio: 1.1 })), /范围/u);
  assert.throws(() => parseAutoEditQualityMetrics(valid({
    renderedDuplicates: [{ firstSeconds: 6, secondSeconds: 1, similarity: 0.99 }],
  })), /顺序/u);
  assert.throws(() => parseAutoEditQualityMetrics(valid({
    audioCuts: [{ atSeconds: 11, beforeRmsDb: -20, afterRmsDb: -18, normalizedSampleJump: 0.1 }],
  }), { durationSeconds: 10 }), /范围/u);
});

test("数组上限与无音轨探针证据不可绕过", () => {
  assert.throws(() => parseAutoEditQualityMetrics(valid({
    renderedDuplicates: Array.from({ length: 121 }, () => ({ firstSeconds: 1, secondSeconds: 2, similarity: 1 })),
  })), /数量/u);
  assert.throws(() => parseAutoEditQualityMetrics(valid({
    audioCuts: Array.from({ length: 65 }, () => ({
      atSeconds: 1, beforeRmsDb: -20, afterRmsDb: -18, normalizedSampleJump: 0.1,
    })),
  })), /数量/u);
  assert.throws(() => parseAutoEditQualityMetrics(valid({ audioPresent: false })), /无音轨/u);
  assert.equal(parseAutoEditQualityMetrics(valid({ audioPresent: false, audioCuts: [] })).audioPresent, false);
});

test("有音轨时每个计划切点都必须有数量与时间对齐的测量", () => {
  assert.doesNotThrow(() => parseAutoEditQualityMetrics(valid(), {
    durationSeconds: 10,
    expectedAudioCutTimes: [3.04],
  }));
  assert.throws(() => parseAutoEditQualityMetrics(valid(), {
    durationSeconds: 10,
    expectedAudioCutTimes: [3, 7],
  }), /数量/u);
  assert.throws(() => parseAutoEditQualityMetrics(valid(), {
    durationSeconds: 10,
    expectedAudioCutTimes: [3.081],
  }), /不对齐/u);
});

test("预期切点只对齐前64项，自身也必须是有效时间", () => {
  const expected = Array.from({ length: 70 }, (_, index) => index / 10);
  const audioCuts = expected.slice(0, 64).map((atSeconds) => ({
    atSeconds,
    beforeRmsDb: -20,
    afterRmsDb: -18,
    normalizedSampleJump: 0.1,
  }));
  assert.equal(parseAutoEditQualityMetrics(valid({ audioCuts }), {
    durationSeconds: 10,
    expectedAudioCutTimes: expected,
  }).audioCuts.length, 64);
  assert.throws(() => parseAutoEditQualityMetrics(valid(), {
    durationSeconds: 10,
    expectedAudioCutTimes: [Number.NaN],
  }), /范围/u);
});

test("无音轨时即使计划有切点，测量也只能是空数组", () => {
  assert.equal(parseAutoEditQualityMetrics(valid({
    audioPresent: false,
    audioCuts: [],
  }), {
    durationSeconds: 10,
    expectedAudioCutTimes: [3, 6],
  }).audioCuts.length, 0);
});

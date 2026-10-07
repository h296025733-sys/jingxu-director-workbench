import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAutoEditPlanAvoidsInFrameRoll,
  computeInFrameRollDetectorTimeoutMs,
} from "../lib/in-frame-roll.ts";

function source(source, segments = []) {
  return {
    source,
    sampleCount: 120,
    segments,
  };
}

function report(sources) {
  return {
    schema_version: 1,
    job_id: "roll-guard-test",
    sources,
  };
}

test("片内方向检测超时随视频时长增长并保留上下限", () => {
  assert.equal(computeInFrameRollDetectorTimeoutMs(10), 120_000);
  assert.equal(computeInFrameRollDetectorTimeoutMs(600), 330_000);
  assert.equal(computeInFrameRollDetectorTimeoutMs(60 * 60 * 8), 45 * 60_000);
  assert.throws(() => computeInFrameRollDetectorTimeoutMs(0), /有效视频时长/u);
});

test("计划门禁允许已覆盖且不碰片内横倒区间的剪点", () => {
  const value = {
    clips: [
      { source: "inputs/a.mp4", kind: "video", start: 0, end: 3.8 },
      { source: "inputs\\b.mp4", kind: "video", start: 6.2, end: 7 },
      { source: "inputs/still.png", kind: "image", duration: 1 },
    ],
  };
  const measured = report([
    source("inputs/a.mp4", [{ start: 4, end: 6, maxAbsDegrees: 74, confidence: 0.91 }]),
    source("inputs/b.mp4", [{ start: 4, end: 6, maxAbsDegrees: 70, confidence: 0.9 }]),
  ]);
  assert.doesNotThrow(() => assertAutoEditPlanAvoidsInFrameRoll(value, measured));
});

test("计划门禁把安全边界内外 0.2 秒作为禁用区间", () => {
  const measured = report([
    source("inputs/a.mp4", [{ start: 4, end: 6, maxAbsDegrees: 74, confidence: 0.91 }]),
  ]);
  assert.throws(
    () => assertAutoEditPlanAvoidsInFrameRoll({
      clips: [{ source: "inputs/a.mp4", kind: "video", start: 3, end: 3.81 }],
    }, measured),
    /3\.80–6\.20s 重叠/u,
  );
});

test("计划门禁要求报告覆盖计划中每一个视频源", () => {
  const value = {
    clips: [
      { source: "inputs/a.mp4", kind: "video", start: 0, end: 1 },
      { source: "inputs/b.mp4", kind: "video", start: 0, end: 1 },
    ],
  };
  assert.throws(
    () => assertAutoEditPlanAvoidsInFrameRoll(value, report([source("inputs/a.mp4")])),
    /未覆盖视频素材：inputs\/b\.mp4/u,
  );
  assert.throws(
    () => assertAutoEditPlanAvoidsInFrameRoll(value, report([])),
    /未覆盖视频素材/u,
  );
});

test("计划门禁拒绝重复报告源和无效视频时间", () => {
  const value = {
    clips: [{ source: "inputs/a.mp4", kind: "video", start: 1, end: 1 }],
  };
  assert.throws(
    () => assertAutoEditPlanAvoidsInFrameRoll(value, report([
      source("inputs/a.mp4"),
      source("inputs\\a.mp4"),
    ])),
    /重复素材/u,
  );
  assert.throws(
    () => assertAutoEditPlanAvoidsInFrameRoll(value, report([source("inputs/a.mp4")])),
    /时间无效/u,
  );
});

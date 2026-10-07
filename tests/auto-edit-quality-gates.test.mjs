import assert from "node:assert/strict";
import test from "node:test";

test('RMS change without a sample jump remains a listening warning, not a forced rollback',()=>{
 const normalOnset=auditAutoEditPostRenderQuality({audioCuts:[{atSeconds:2,beforeRmsDb:-65,afterRmsDb:-20,normalizedSampleJump:.01}]});
 assert.equal(normalOnset.passed,true);
 assert.equal(normalOnset.issues[0].severity,'warning');
 const edge=auditAutoEditPostRenderQuality({audioCuts:[{atSeconds:2,beforeRmsDb:-25,afterRmsDb:-20,normalizedSampleJump:.7}]});
 assert.equal(edge.passed,false);assert.equal(edge.issues[0].severity,'error');
});
import {
  auditAutoEditPlanQuality,
  auditAutoEditPostRenderQuality,
  mergeAutoEditQualityResults,
} from "../lib/auto-edit-quality-gates.ts";

function plan(overrides = {}) {
  return {
    output: { width: 1080, height: 1920 },
    clips: [
      { source: "a.mp4", kind: "video", start: 0, end: 1.1, fit: "fill" },
      { source: "b.mp4", kind: "video", start: 0, end: 2.2, fit: "fill" },
    ],
    overlays: [
      { kind: "caption", start: 0, end: 1.1, text: "看这里", x: 540, y: 1450 },
    ],
    finishing: { audio_edge_fade_ms: 12 },
    ...overrides,
  };
}

test("计划门禁拦截旋转源、重复取段、字幕出界与音量突变", () => {
  const result = auditAutoEditPlanQuality(plan({
    clips: [
      { source: "a.mp4", kind: "video", start: 0, end: 2, fit: "contain", audio_gain_db: 0 },
      { source: "a.mp4", kind: "video", start: 0.1, end: 2, fit: "fill", audio_gain_db: 16 },
    ],
    overlays: [
      { kind: "caption", start: 0, end: 0.3, text: "一条过短的字幕", x: 20, y: 1900 },
    ],
  }), [{ source: "a.mp4", width: 1920, height: 1080, rotationDegrees: 90 }]);
  assert.equal(result.passed, false);
  const codes = new Set(result.issues.map((issue) => issue.code));
  for (const code of [
    "ROTATED_SOURCE",
    "LETTERBOX_RISK",
    "REPEATED_SOURCE_SPAN",
    "CAPTION_OUTSIDE_SAFE_AREA",
    "CAPTION_TIMING",
    "AUDIO_GAIN_JUMP",
  ]) assert.equal(codes.has(code), true, code);
  assert.equal(
    result.issues.find((issue) => issue.code === "ROTATED_SOURCE")?.severity,
    "warning",
  );
});

test("计划门禁能识别机械均切和口播字幕碰撞", () => {
  const clips = Array.from({ length: 7 }, (_, index) => ({
    source: `${index}.mp4`, kind: "video", start: 0, end: 1.5, fit: "fill",
  }));
  const result = auditAutoEditPlanQuality(plan({
    clips,
    overlays: [
      { kind: "caption", start: 0, end: 1.2, text: "第一句" },
      { kind: "caption", start: 1, end: 2, text: "第二句" },
    ],
  }));
  const codes = new Set(result.issues.map((issue) => issue.code));
  assert.equal(codes.has("MECHANICAL_CLIP_DURATIONS"), true);
  assert.equal(codes.has("CAPTION_COLLISION"), true);
});

test("视频镜头时长必须按取段与倍速计算，不信任 duration 占位", () => {
  const result = auditAutoEditPlanQuality(plan({
    clips: [
      {
        source: "a.mp4", kind: "video", start: 2, end: 8, speed: 2,
        duration: 99, fit: "fill", mute: true,
      },
    ],
    overlays: [
      { kind: "caption", start: 2.5, end: 3.2, text: "三秒内", x: 0.5, y: 0.75 },
      { kind: "caption", start: 3.1, end: 4, text: "超出成片", x: 0.5, y: 0.75 },
    ],
  }));
  assert.equal(
    result.issues.some((issue) => issue.code === "CAPTION_TIMING" && issue.details?.timelineSeconds === 3),
    true,
  );
});

test("字幕坐标同时兼容归一化与像素值", () => {
  const normalized = auditAutoEditPlanQuality(plan({
    overlays: [{ kind: "caption", start: 0, end: 1, text: "安全", x: 0.5, y: 0.75 }],
  }));
  const pixels = auditAutoEditPlanQuality(plan({
    overlays: [{ kind: "caption", start: 0, end: 1, text: "安全", x: 540, y: 1440 }],
  }));
  assert.equal(normalized.issues.some((issue) => issue.code === "CAPTION_OUTSIDE_SAFE_AREA"), false);
  assert.equal(pixels.issues.some((issue) => issue.code === "CAPTION_OUTSIDE_SAFE_AREA"), false);
});

test("多段未静音原声硬切必须有边缘淡化", () => {
  const clips = Array.from({ length: 5 }, (_, index) => ({
    source: `${index}.mp4`, kind: "video", start: 0, end: index + 1,
    speed: 1, fit: "fill", mute: false,
  }));
  const missing = auditAutoEditPlanQuality(plan({ clips, overlays: [], finishing: {} }));
  const short = auditAutoEditPlanQuality(plan({
    clips, overlays: [], finishing: { audio_edge_fade_ms: 4 },
  }));
  const safe = auditAutoEditPlanQuality(plan({
    clips, overlays: [], finishing: { audio_edge_fade_ms: 12 },
  }));
  assert.equal(missing.issues.some((issue) => issue.code === "MISSING_AUDIO_EDGE_FADE" && issue.severity === "error"), true);
  assert.equal(short.issues.some((issue) => issue.code === "MISSING_AUDIO_EDGE_FADE"), true);
  assert.equal(safe.issues.some((issue) => issue.code === "MISSING_AUDIO_EDGE_FADE"), false);
});

test("真实转场会缩短时间线并由交叉淡化承担该边界音频", () => {
  const result = auditAutoEditPlanQuality(plan({
    clips: [
      { source: "a.mp4", kind: "video", start: 0, end: 1.5, fit: "fill", mute: false },
      { source: "b.mp4", kind: "video", start: 0, end: 1.8, fit: "fill", mute: false },
    ],
    transitions: [{ after_clip: 0, duration: 0.3 }],
    overlays: [{ kind: "caption", start: 2.8, end: 3.2, text: "超出转场后的成片" }],
    finishing: {},
  }));
  assert.equal(
    result.issues.some((issue) =>
      issue.code === "CAPTION_TIMING" && issue.details?.timelineSeconds === 3
    ),
    true,
  );
  assert.equal(
    result.issues.some((issue) => issue.code === "MISSING_AUDIO_EDGE_FADE"),
    false,
  );
});

test("多数镜头时长集中在同一模板值时，少数长短镜头不应掩盖机械均切", () => {
  const durations = [2.5, 1.5, 2.25, 2.25, 2.25, 2.25, 2.5, 2.5, 4, 2.5, 2.5, 3];
  const result = auditAutoEditPlanQuality(plan({
    clips: durations.map((duration, index) => ({
      source: `${index}.mp4`, kind: "video", start: 0, end: duration, fit: "fill",
    })),
    overlays: [],
  }));
  assert.equal(result.issues.some((issue) => issue.code === "MECHANICAL_CLIP_DURATIONS"), true);
});

test("渲染后门禁拦截横倒、黑边、静态首秒、重复画面和音频爆点", () => {
  const result = auditAutoEditPostRenderQuality({
    displayRotationDegrees: 90,
    blackBorderRatio: 0.07,
    openingFreezeSeconds: 1.3,
    openingMotionScore: 0.001,
    renderedDuplicates: [{ firstSeconds: 1, secondSeconds: 8, similarity: 0.998 }],
    audioCuts: [{
      atSeconds: 3.2,
      beforeRmsDb: -30,
      afterRmsDb: -8,
      normalizedSampleJump: 0.7,
    }],
  });
  assert.equal(result.passed, false);
  assert.deepEqual(
    new Set(result.issues.map((issue) => issue.code)),
    new Set([
      "ROTATED_OUTPUT",
      "VISIBLE_BLACK_BORDER",
      "STATIC_OPENING",
      "REPEATED_RENDERED_SHOT",
      "AUDIO_CUT_DISCONTINUITY",
    ]),
  );
});

test("正常计划与渲染测量可通过，合并结果不丢问题", () => {
  const planned = auditAutoEditPlanQuality(plan({
    overlays: [{ kind: "caption", start: 0, end: 1.1, text: "看这里", x: 0.5, y: 0.75 }],
  }));
  const rendered = auditAutoEditPostRenderQuality({
    displayRotationDegrees: 0,
    blackBorderRatio: 0,
    openingFreezeSeconds: 0.15,
    openingMotionScore: 0.04,
    renderedDuplicates: [],
    audioCuts: [{ atSeconds: 1.1, beforeRmsDb: -20, afterRmsDb: -18, normalizedSampleJump: 0.1 }],
  });
  assert.equal(planned.passed, true);
  assert.equal(rendered.passed, true);
  assert.deepEqual(mergeAutoEditQualityResults(planned, rendered), {
    passed: true,
    issues: [],
    errorCount: 0,
    warningCount: 0,
  });
});

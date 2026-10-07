import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applySafeAutoEditFinishingDefaults,
  buildAutoEditCutTimes,
  buildAutoEditTransitionTimes,
  buildPostRenderReviewTimes,
  compactQualityIssues,
  copyFileCancellable,
  prepareAutoEditRepairPlan,
  resolveAutoEditReviewDecision,
  resolveReviewVideoDuration,
} from "../lib/auto-edit.ts";
import { auditAutoEditPlanQuality } from "../lib/auto-edit-quality-gates.ts";

function plan(overrides = {}) {
  return {
    schema_version: 1,
    job_id: "mx-edit-1-11111111-1111-4111-8111-111111111111",
    output: {
      filename: "initial.mp4",
      width: 1080,
      height: 1920,
      fps: 30,
      video_codec: "libx264",
      crf: 20,
      preset: "medium",
      audio_bitrate: "192k",
    },
    clips: [
      { source: "a.mp4", kind: "video", start: 0, end: 2, speed: 1, mute: false },
      { source: "b.mp4", kind: "video", start: 1, end: 5, speed: 2, mute: false },
      { source: "c.jpg", kind: "image", duration: 1 },
    ],
    overlays: [{ kind: "caption", start: 2.2, end: 3.2, text: "重点" }],
    finishing: { preset: "none", flashes: [] },
    ...overrides,
  };
}

test("字幕/剪点返修保留已生效水印处理，明确的水印返修仍允许撤销误擦", () => {
  const initial = plan({watermark_cleanup:{inspected:true,deferred:0,regions:[{source:'a.mp4',safe_to_remove:true},{source:'unused.mp4',safe_to_remove:true}]}});
  const revised = plan({watermark_cleanup:{inspected:true,regions:[]}});
  const kept = prepareAutoEditRepairPlan(initial,revised);
  assert.deepEqual(kept.watermark_cleanup.regions,[{source:'a.mp4',safe_to_remove:true}]);
  assert.deepEqual(prepareAutoEditRepairPlan(initial,revised,'fixed.mp4',false).watermark_cleanup.regions,[]);
  assert.equal(initial.watermark_cleanup.regions.length,2);
});

test("成片复检时间点覆盖首三秒、真实切点两侧、字幕中点并限制为24帧", () => {
  const source = plan();
  assert.deepEqual(buildAutoEditCutTimes(source), [2, 4]);
  const times = buildPostRenderReviewTimes(source, 5, 24);
  assert.equal(times.length <= 24, true);
  for (const expected of [0, 2.7, 1.92, 2.08, 3.92, 4.08]) {
    assert.equal(times.some((time) => Math.abs(time - expected) < 0.001), true, String(expected));
  }
});

test("转场中点进入视觉复检但不会被误判为原声音频硬切", () => {
  const source = plan({
    transitions: [{ after_clip: 0, type: "dissolve", duration: 0.2, reason: "time_change" }],
  });
  assert.deepEqual(buildAutoEditTransitionTimes(source), [1.9]);
  assert.deepEqual(buildAutoEditCutTimes(source), [3.8]);
  const times = buildPostRenderReviewTimes(source, 4.8, 24);
  assert.equal(times.includes(1.9), true);
  assert.equal(times.includes(3.72), true);
  assert.equal(times.includes(3.88), true);
});

test("成片复检在保留钩子细节时仍均匀覆盖全片并采到九成后的尾部", () => {
  const times = buildPostRenderReviewTimes(plan(), 40, 24);
  assert.equal(times.length, 24);
  assert.equal(times.some((time) => time >= 36), true);
  for (const [start, end] of [[0, 10], [10, 20], [20, 30], [30, 40]]) {
    assert.equal(
      times.some((time) => time >= start && time < end),
      true,
      `${start}-${end}`,
    );
  }
  assert.equal(buildPostRenderReviewTimes(plan(), 0.2, 1)[0], 0.1);
});

test("review sampling uses video duration and does not seek into an AAC-only tail", () => {
  const duration = resolveReviewVideoDuration({ streams: [{ duration: "27.800000", nb_frames: "834", avg_frame_rate: "30/1" }] }, 27.9);
  assert.equal(duration, 27.8);
  assert.equal(Math.max(...buildPostRenderReviewTimes(plan(), duration)) < 833 / 30, true);
  assert.equal(resolveReviewVideoDuration({ streams: [{ duration: "N/A", nb_frames: "N/A", avg_frame_rate: "0/0" }] }, 21), 21);
  const fps12 = plan({ output: { fps: 12 } });
  assert.equal(Math.max(...buildPostRenderReviewTimes(fps12, 1)) < 11 / 12, true);
});

test("确定性质量问题优先保留不同代码且每类最多两条", () => {
  const repeated = Array.from({ length: 20 }, (_, index) => ({
    code: "CAPTION_TIMING",
    severity: "error",
    message: `字幕问题${index}`,
    atSeconds: index,
  }));
  const issues = compactQualityIssues({
    passed: false,
    errorCount: 21,
    warningCount: 1,
    issues: [
      ...repeated,
      { code: "VISIBLE_BLACK_BORDER", severity: "error", message: "黑边" },
      { code: "STATIC_OPENING", severity: "warning", message: "开头静止" },
    ],
  });
  assert.equal(issues.filter((issue) => issue.code === "CAPTION_TIMING").length, 2);
  assert.equal(issues.some((issue) => issue.code === "VISIBLE_BLACK_BORDER"), true);
  assert.equal(issues.some((issue) => issue.code === "STATIC_OPENING"), true);
});

test("成片复制可被取消且不会留下半文件", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mx-copy-cancel-"));
  const source = path.join(root, "source.bin");
  const copied = path.join(root, "copied.bin");
  const canceled = path.join(root, "canceled.bin");
  fs.writeFileSync(source, Buffer.alloc(2 * 1024 * 1024, 7));
  try {
    await copyFileCancellable(source, copied, new AbortController().signal);
    assert.equal(fs.statSync(copied).size, fs.statSync(source).size);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => copyFileCancellable(source, canceled, controller.signal),
      { name: "AbortError" },
    );
    assert.equal(fs.existsSync(canceled), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("多段保留原声时自动补18ms边缘淡化，但不覆盖已有安全值", () => {
  const defaulted = applySafeAutoEditFinishingDefaults(plan(), "keep");
  assert.equal(defaulted.finishing.audio_edge_fade_ms, 18);
  assert.equal(defaulted.finishing.loudness_target_lufs, -14);
  assert.equal(defaulted.finishing.true_peak_limit_db, -1.5);
  const explicit = applySafeAutoEditFinishingDefaults(plan({
    finishing: { preset: "none", flashes: [], audio_edge_fade_ms: 24 },
  }), "keep");
  assert.equal(explicit.finishing.audio_edge_fade_ms, 24);
  const muted = applySafeAutoEditFinishingDefaults(plan(), "mute");
  assert.equal("audio_edge_fade_ms" in muted.finishing, false);
  assert.equal(muted.finishing.loudness_target_lufs, null);
  const punchyProduct = applySafeAutoEditFinishingDefaults(
    plan(),
    "keep",
    "product_demo",
    "punchy",
  );
  assert.equal(punchyProduct.finishing.loudness_target_lufs, -12.5);
  assert.equal(punchyProduct.finishing.true_peak_limit_db, -1);
});

test("安全默认值限制字幕与长标签，同时不乱动安全标题", () => {
  const adjusted = applySafeAutoEditFinishingDefaults(plan({
    overlays: [
      { kind: "caption", start: 0, end: 1, text: "底部字幕", x: 0.99, y: 0.9 },
      { kind: "caption", start: 1, end: 2, text: "像素字幕", x: 20, y: 1900 },
      { kind: "title", start: 0, end: 1, text: "标题", x: 0.5, y: 0.9 },
      {
        kind: "label",
        start: 2,
        end: 3,
        text: "2% salicylic acid body wash.",
        x: 0.31,
        y: 0.73,
        preset: "feature",
      },
    ],
  }), "keep");
  assert.deepEqual(
    adjusted.overlays.map((overlay) => [overlay.kind, overlay.x, overlay.y]),
    [
      ["caption", 0.92, 0.78],
      ["caption", 86.4, 1497.6],
      ["title", 0.5, 0.9],
      ["label", 0.38, 0.73],
    ],
  );
  const quality = auditAutoEditPlanQuality(adjusted);
  assert.equal(
    quality.issues.some((issue) => issue.code === "CAPTION_OUTSIDE_SAFE_AREA"),
    false,
  );
});

test("自动修片只能改剪辑内容，不能偷偷改变分辨率、编码或覆盖第一版", () => {
  const initial = plan();
  const revised = plan({
    job_id: "wrong-job",
    output: {
      filename: "overwrite.mp4",
      width: 720,
      height: 1280,
      fps: 24,
      video_codec: "other",
      crf: 40,
      preset: "slow",
      audio_bitrate: "64k",
    },
    clips: [{ source: "a.mp4", kind: "video", start: 0.2, end: 1.7, speed: 1 }],
  });
  const repaired = prepareAutoEditRepairPlan(initial, revised, "review-repaired-safe.mp4");
  assert.equal(repaired.job_id, initial.job_id);
  assert.deepEqual(repaired.output, {
    ...initial.output,
    filename: "review-repaired-safe.mp4",
  });
  assert.deepEqual(repaired.clips, revised.clips);
  assert.throws(
    () => prepareAutoEditRepairPlan(initial, revised, "../overwrite.mp4"),
    /文件名无效/u,
  );
});

test("复检模型不能用通过结论覆盖确定性硬错误", () => {
  const badQuality = auditAutoEditPlanQuality(plan({
    clips: [
      { source: "a.mp4", kind: "video", start: 0, end: 2, speed: 1, mute: false },
      { source: "a.mp4", kind: "video", start: 0.1, end: 2.1, speed: 1, mute: false },
    ],
    finishing: { preset: "none", flashes: [], audio_edge_fade_ms: 18 },
  }));
  assert.equal(badQuality.errorCount > 0, true);
  assert.equal(resolveAutoEditReviewDecision("pass", badQuality), "needs_attention");
  assert.equal(resolveAutoEditReviewDecision("repair", badQuality), "repair");
});

test("没有确定性硬错误时保留复检模型的通过结论", () => {
  const goodQuality = auditAutoEditPlanQuality(plan({
    clips: [{ source: "a.mp4", kind: "video", start: 0, end: 2, speed: 1, mute: false }],
    overlays: [],
  }));
  assert.equal(goodQuality.errorCount, 0);
  assert.equal(resolveAutoEditReviewDecision("pass", goodQuality), "pass");
});

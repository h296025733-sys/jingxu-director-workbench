import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildAutoVideoEditingReviewSchema,
  collectAutoVideoEditingReviewEvidence,
  normalizeAutoVideoEditingReviewQualityIssues,
  normalizeEditingPlanParameters,
  validateAutoVideoEditingReview,
  validateAutoVideoEditPlan,
} from "../lib/codex-director.ts";

const sources = [
  {
    source: "inputs/01_demo.mp4",
    kind: "video",
    durationSeconds: 20,
    width: 1080,
    height: 1920,
  },
];

const params = normalizeEditingPlanParameters({
  editMode: "smart",
  editTargetDuration: 0,
  editAspect: "vertical",
  editCaptions: "auto",
  captionStyle: "clean",
  editAudio: "keep",
  transcribe: true,
});

function fullPlan(overrides = {}) {
  return {
    schema_version: 1,
    job_id: "job-review-1",
    intent_summary: "用可见动作开场，保留完整动作，再清楚收尾。",
    output: {
      filename: "reviewed.mp4",
      width: 1080,
      height: 1920,
      fps: 30,
      video_codec: "libx264",
      crf: 20,
      preset: "medium",
      audio_bitrate: "192k",
    },
    clips: [
      {
        source: "inputs/01_demo.mp4",
        kind: "video",
        start: 1,
        end: 8,
        duration: 1,
        speed: 1,
        fit: "fill",
        audio_gain_db: 0,
        mute: false,
        motion: {
          zoom_start: 1,
          zoom_end: 1.05,
          focus_x_start: 0.5,
          focus_x_end: 0.5,
          focus_y_start: 0.5,
          focus_y_end: 0.5,
        },
      },
    ],
    overlays: [
      {
        kind: "caption",
        start: 0,
        end: 1.2,
        text: "看这里",
        preset: "fine_caption",
        animation: "fade",
        color: "#FFFFFF",
        outline_color: "#000000",
        x: 0.5,
        y: 0.72,
        align: 2,
        layer: 10,
      },
    ],
    music: null,
    voiceover: null,
    sfx: [],
    finishing: { preset: "none", audio_edge_fade_ms: 18, flashes: [] },
    ...overrides,
  };
}

function reviewContext() {
  return {
    jobId: "job-review-1",
    sources,
    brief: "开头字幕写：看这里",
    transcriptTexts: ["看这里"],
    params,
  };
}

test('post-render review accepts bounded template-owned typography, not arbitrary style injection',()=>{
 const p=fullPlan();p.overlays[0].font_size=54;p.overlays[0].background_color='#FFFFFF';
 assert.doesNotThrow(()=>validateAutoVideoEditPlan(p,reviewContext()));
 p.overlays[0].font_size=9999;
 assert.throws(()=>validateAutoVideoEditPlan(p,reviewContext()),/font_size/);
});

function issue(overrides = {}) {
  return {
    code: "MECHANICAL_PACING",
    severity: "warning",
    start: 0,
    end: 2,
    evidence: "成片接触表显示开头两个镜头节拍完全相同。",
    repair: "保留动作完整的镜头，并按信息变化调整剪点。",
    ...overrides,
  };
}

test("review schema narrows every revised-plan source to the current job", () => {
  const schema = buildAutoVideoEditingReviewSchema({
    visualSources: ["inputs/01_demo.mp4"],
    audioSources: [],
  });
  assert.deepEqual(schema.properties.decision.enum, ["pass", "repair", "needs_attention"]);
  assert.equal(schema.properties.issues.maxItems, 12);
  const revised = schema.properties.revisedPlan.anyOf[1];
  assert.deepEqual(
    revised.properties.clips.items.properties.source.enum,
    ["inputs/01_demo.mp4"],
  );
  assert.deepEqual(revised.properties.music, { type: "null" });
  assert.deepEqual(
    revised.properties.finishing.properties.audio_edge_fade_ms,
    {
      type: "integer",
      minimum: 0,
      maximum: 100,
      description:
        "Short audio fade on each video-clip edge; 18ms is the safe default unless source continuity requires another measured value.",
    },
  );
});

test("trusted deterministic findings are bounded and reject extra fields", () => {
  assert.deepEqual(
    normalizeAutoVideoEditingReviewQualityIssues([
      {
        code: "STATIC_OPENING",
        severity: "warning",
        message: "首秒动作不足",
        atSeconds: 0,
      },
      {
        code: "MISSING_AUDIO_EDGE_FADE",
        severity: "error",
        message: "相邻原声镜头缺少边缘淡化",
        atSeconds: 1.2,
      },
    ]),
    [
      {
        code: "STATIC_OPENING",
        severity: "warning",
        message: "首秒动作不足",
        atSeconds: 0,
      },
      {
        code: "MISSING_AUDIO_EDGE_FADE",
        severity: "error",
        message: "相邻原声镜头缺少边缘淡化",
        atSeconds: 1.2,
      },
    ],
  );
  assert.throws(
    () => normalizeAutoVideoEditingReviewQualityIssues([{
      code: "STATIC_OPENING",
      severity: "warning",
      message: "首秒动作不足",
      atSeconds: 0,
      details: { score: 0 },
    }]),
    /未知字段/u,
  );
  assert.throws(
    () => normalizeAutoVideoEditingReviewQualityIssues(Array.from({ length: 17 }, () => ({
      code: "STATIC_OPENING",
      severity: "warning",
      message: "首秒动作不足",
      atSeconds: 0,
    }))),
    /最多 16 条/u,
  );
});

test("pass and needs_attention cannot smuggle a replacement plan", () => {
  assert.deepEqual(
    validateAutoVideoEditingReview({
      decision: "pass",
      summary: "没有发现可由现有证据支持的具体问题。",
      issues: [],
      revisedPlan: null,
    }, reviewContext()),
    {
      decision: "pass",
      summary: "没有发现可由现有证据支持的具体问题。",
      issues: [],
      revisedPlan: null,
    },
  );
  assert.throws(
    () => validateAutoVideoEditingReview({
      decision: "pass",
      summary: "通过",
      issues: [],
      revisedPlan: fullPlan(),
    }, reviewContext()),
    /不得返回修订计划/u,
  );
  assert.equal(
    validateAutoVideoEditingReview({
      decision: "needs_attention",
      summary: "需要当前渲染器不支持的对象追踪。",
      issues: [issue({ code: "BAD_CROP", severity: "error" })],
      revisedPlan: null,
    }, reviewContext()).decision,
    "needs_attention",
  );
});

test("repair must pass both the task-bound plan validator and the mode validator", () => {
  const repaired = validateAutoVideoEditingReview({
    decision: "repair",
    summary: "收紧开头并保留完整动作。",
    issues: [issue()],
    revisedPlan: fullPlan(),
  }, reviewContext());
  assert.equal(repaired.decision, "repair");
  assert.equal(repaired.revisedPlan.job_id, "job-review-1");

  const inventedSource = fullPlan({
    clips: [{ ...fullPlan().clips[0], source: "inputs/not-present.mp4" }],
  });
  assert.throws(
    () => validateAutoVideoEditingReview({
      decision: "repair",
      summary: "错误修订",
      issues: [issue()],
      revisedPlan: inventedSource,
    }, reviewContext()),
    /source 不是已提供的可视素材/u,
  );
});

test("review evidence accepts only fixed sheets and QA frame names", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-edit-review-"));
  try {
    const reports = path.join(root, "reports");
    const qaFrames = path.join(reports, "qa-frames");
    fs.mkdirSync(qaFrames, { recursive: true });
    const sheet = path.join(reports, "review-contact-sheet-01.jpg");
    const start = path.join(qaFrames, "start.jpg");
    const critical = path.join(qaFrames, "critical-000-fine_caption.jpg");
    const arbitrary = path.join(reports, "arbitrary.jpg");
    for (const file of [sheet, start, critical, arbitrary]) fs.writeFileSync(file, "jpeg");

    assert.deepEqual(
      collectAutoVideoEditingReviewEvidence(root, [critical, sheet, start]).map(
        ({ label }) => label,
      ),
      [
        "REVIEW_CONTACT_SHEET_01",
        "QA_FRAME_CRITICAL-000-FINE_CAPTION",
        "QA_FRAME_START",
      ],
    );
    assert.throws(
      () => collectAutoVideoEditingReviewEvidence(root, [arbitrary]),
      /只允许固定接触表或 QA 抽帧/u,
    );
    const secondOnly = path.join(reports, "review-contact-sheet-02.jpg");
    fs.writeFileSync(secondOnly, "jpeg");
    assert.throws(
      () => collectAutoVideoEditingReviewEvidence(root, [secondOnly]),
      /必须从 01 开始连续编号/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

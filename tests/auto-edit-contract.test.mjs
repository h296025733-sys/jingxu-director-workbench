import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const testData = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-auto-edit-test-"));
process.env.DW_TEST_DATA_DIR = testData;

const {
  applyConservativeEditControls,
  assertAutoEditPlanAvoidsSourceBlack,
  buildPlanningSampleTimes,
  shouldAttemptAudioEdgeRepair,
  summarizeAutoEditQa,
} = await import(
  `../lib/auto-edit.ts?contract=${Date.now()}`
);
const { toTaskOut, toTaskSummaryOut } = await import(
  `../lib/dto.ts?contract=${Date.now()}`
);
const {
  autoEditTranscriptValidationError,
  normalizeAutoEditTranscriptForRetry,
} = await import("../app/api/tasks/auto-edit-params.ts");

test("口播类新任务必须在服务端开启真实转录", () => {
  for (const editMode of ["talking_head", "digital_presenter"]) {
    assert.match(
      autoEditTranscriptValidationError("auto_edit", {
        editMode,
        transcribe: false,
      }),
      /必须开启「识别说话内容」/u,
    );
    assert.equal(
      autoEditTranscriptValidationError("auto_edit", {
        editMode,
        transcribe: true,
      }),
      null,
    );
  }
  assert.equal(
    autoEditTranscriptValidationError("auto_edit", {
      editMode: "smart",
      transcribe: false,
    }),
    null,
  );
});

test("口播类旧任务重试会安全补开转录而不改动其他参数", () => {
  const historical = {
    editMode: "digital_presenter",
    transcribe: false,
    brief: "保留现有人物、声音和口型同步",
  };
  const normalized = normalizeAutoEditTranscriptForRetry("auto_edit", historical);
  assert.deepEqual(normalized, {
    ...historical,
    transcribe: true,
  });
  assert.equal(historical.transcribe, false, "must not mutate the stored source params");

  const smart = { editMode: "smart", transcribe: false };
  assert.equal(normalizeAutoEditTranscriptForRetry("auto_edit", smart), smart);
});

test("保守剪辑会执行画幅、静音和目标时长，而不改写素材路径", () => {
  const plan = {
    schema_version: 1,
    job_id: "mx-edit-9-3f45d084-0f5d-4d78-952b-bf6107b94711",
    intent_summary: "draft",
    output: { filename: "draft.mp4", width: 1080, height: 1920, fps: 30 },
    clips: [
      {
        source: "inputs/01_source.mp4",
        kind: "video",
        start: 1,
        end: 11,
        speed: 1,
        fit: "fill",
        audio_gain_db: 0,
        mute: false,
      },
    ],
    overlays: [
      { kind: "caption", start: 4, end: 8, text: "会被截短" },
    ],
    music: null,
  };
  const controlled = applyConservativeEditControls(plan, {
    brief: "保留前五秒",
    editMode: "smart",
    editTargetDuration: 5,
    editAspect: "horizontal",
    editCaptions: "auto",
    captionStyle: "clean",
    editAudio: "mute",
    transcribe: true,
  });
  assert.equal(controlled.output.width, 1920);
  assert.equal(controlled.output.height, 1080);
  assert.equal(controlled.clips[0].source, "inputs/01_source.mp4");
  assert.equal(controlled.clips[0].end, 6);
  assert.equal(controlled.clips[0].mute, true);
  assert.equal(controlled.overlays[0].end, 5);
  assert.equal(plan.clips[0].end, 11, "must not mutate the draft plan");
});

test("技术检查摘要只保留员工需要的有限字段", () => {
  const summary = summarizeAutoEditQa({
    status: "LOCAL_TECHNICAL_QA_PASS",
    observed: {
      duration_seconds: 12.5,
      video: { width: 1080, height: 1920, fps: 30 },
      audio: { codec: "aac" },
    },
    checks: {
      full_decode: true,
      video_stream_present: true,
      audio_stream_present: true,
    },
    black_spans_over_0_5_seconds: [],
    sample_frames: ["outside/path/start.jpg", "outside/path/end.jpg"],
    output: "outside/path/final.mp4",
  });
  assert.deepEqual(
    {
      durationSeconds: summary.durationSeconds,
      width: summary.width,
      height: summary.height,
      fps: summary.fps,
      audioPresent: summary.audioPresent,
      blackFrameSpanCount: summary.blackFrameSpanCount,
      sampledFrameCount: summary.sampledFrameCount,
    },
    {
      durationSeconds: 12.5,
      width: 1080,
      height: 1920,
      fps: 30,
      audioPresent: true,
      blackFrameSpanCount: 0,
      sampledFrameCount: 2,
    },
  );
  assert.equal(JSON.stringify(summary).includes("outside/path"), false);
});

test("规划取样兼顾首三秒、场景边界和全片并严格限量", () => {
  const times = buildPlanningSampleTimes(45, [4, 10, 20, 35], 24);
  assert.equal(times.length <= 24, true);
  assert.deepEqual(times, [...times].sort((left, right) => left - right));
  assert.equal(times.filter((value) => value <= 3).length >= 5, true);
  assert.equal(times.some((value) => Math.abs(value - 9.9) < 0.02), true);
  assert.equal(times.some((value) => Math.abs(value - 10.1) < 0.02), true);
  assert.equal(times.some((value) => value > 40), true);
  assert.equal(times[times.length - 1] >= 44.6, true);
  assert.equal(times[times.length - 1] <= 44.7, true);
});

test("容器时长略长于最后一帧时不会抽取到无画面尾部", () => {
  const times = buildPlanningSampleTimes(30.041667, [], 48);
  assert.equal(times.at(-1) <= 29.7, true);
  assert.equal(times.at(-1) >= 29.6, true);
});

test("只对保留原声且唯一硬错误为采样突变的真实剪点尝试音频修复", () => {
  const plan = {
    clips: [
      { kind: "video", start: 0, end: 2, speed: 1 },
      { kind: "video", start: 2, end: 4, speed: 1 },
    ],
    finishing: { audio_edge_fade_ms: 18 },
  };
  const quality = {
    passed: false,
    errorCount: 1,
    warningCount: 0,
    issues: [{ code: "AUDIO_CUT_DISCONTINUITY", severity: "error", message: "采样突变" }],
  };
  assert.equal(shouldAttemptAudioEdgeRepair(quality, plan, "keep"), true);
  assert.equal(shouldAttemptAudioEdgeRepair(quality, plan, "mute"), false);
  assert.equal(shouldAttemptAudioEdgeRepair(quality, { ...plan, clips: plan.clips.slice(0, 1) }, "keep"), false);
  assert.equal(shouldAttemptAudioEdgeRepair({ ...quality, issues: [...quality.issues, { code: "REPEATED_RENDERED_SHOT", severity: "error", message: "重复镜头" }] }, plan, "keep"), false);
  assert.equal(shouldAttemptAudioEdgeRepair(quality, { ...plan, finishing: { audio_edge_fade_ms: 80 } }, "keep"), false);
});

function passingQa(blackSpans = [], durationSeconds = 10) {
  return {
    status: "LOCAL_TECHNICAL_QA_PASS",
    observed: {
      duration_seconds: durationSeconds,
      video: { width: 1080, height: 1920, fps: 30 },
      audio: null,
    },
    checks: {
      full_decode: true,
      video_stream_present: true,
      audio_stream_present: false,
    },
    black_spans_over_0_5_seconds: blackSpans,
    sample_frames: [],
  };
}

test("技术检查拒绝明显长黑屏和累计黑屏，但容许短转场", () => {
  assert.throws(
    () => summarizeAutoEditQa(passingQa([{ start: 2, end: 4, duration: 2 }])),
    /明显黑屏/,
  );
  assert.throws(
    () => summarizeAutoEditQa(passingQa([
      { start: 2, end: 2.7, duration: 0.7 },
      { start: 5, end: 5.7, duration: 0.7 },
    ])),
    /明显黑屏/,
  );
  assert.equal(
    summarizeAutoEditQa(
      passingQa([{ start: 0, end: 0.6, duration: 0.6 }], 20),
    ).status,
    "passed",
  );
});

test("渲染前拒绝任何跨入真实源视频黑场的剪辑范围", () => {
  const report = {
    schema_version: 1,
    job_id: "mx-edit-166-3f45d084-0f5d-4d78-952b-bf6107b94711",
    sources: [{
      source: "inputs/01_source.mp4",
      segments: [{ start: 16.792, end: 19.167, duration: 2.375 }],
    }],
  };
  const overlapping = {
    clips: [{
      source: "inputs/01_source.mp4",
      kind: "video",
      start: 15.8,
      end: 20.1,
    }],
  };
  assert.throws(
    () => assertAutoEditPlanAvoidsSourceBlack(overlapping, report),
    /素材黑场禁用区间 16\.71–19\.25s/u,
  );
  assert.doesNotThrow(() => assertAutoEditPlanAvoidsSourceBlack({
    clips: [
      { source: "inputs/01_source.mp4", kind: "video", start: 12, end: 16.7 },
      { source: "inputs/01_source.mp4", kind: "video", start: 19.3, end: 22 },
    ],
  }, report));
});

test("自动剪辑列表摘要保留显示所需字段但不泄露员工要求", () => {
  const summary = toTaskSummaryOut({
    id: 70,
    video_id: "video-secret-id",
    video_name: "source.mp4",
    feature_id: "auto_edit",
    params_json: JSON.stringify({
      brief: "这段员工要求不能进入列表轮询",
      editMode: "talking_head",
      editCaptions: "off",
      captionStyle: "punchy",
      transcribe: true,
      referenceImages: ["asset-secret-id"],
    }),
    status: "running",
    progress: 55,
    message: "正在剪辑",
    result_json: null,
    error: null,
    asset_schedule_complete: 0,
    created_by: "employee",
    created_at: "2026-08-31T00:00:00Z",
    started_at: "2026-08-31T00:00:01Z",
    finished_at: null,
  });
  assert.deepEqual(summary.params, {
    transcribe: true,
    editMode: "talking_head",
    editCaptions: "off",
    captionStyle: "punchy",
    subtitleLanguage: "en",
  });
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("这段员工要求不能进入列表轮询"), false);
  assert.equal(serialized.includes("asset-secret-id"), false);
});

test("员工任务详情不泄露剪辑计划、QA、线程或内部素材编号", () => {
  const task = toTaskOut({
    id: 71,
    video_id: "video-secret-id",
    video_name: "source.mp4",
    feature_id: "auto_edit",
    params_json: JSON.stringify({
      brief: "剪掉停顿",
      editMode: "digital_presenter",
      referenceImages: ["asset-secret-id"],
      inputReferenceLabels: "secret label map",
      editTargetDuration: 15,
      editAspect: "vertical",
      editCaptions: "auto",
      captionStyle: "punchy",
      editAudio: "keep",
      transcribe: false,
    }),
    status: "succeeded",
    progress: 100,
    message: "视频已经剪好",
    result_json: JSON.stringify({
      message: "视频已经剪好",
      report: "internal report",
      media: [{
        type: "video",
        url: "/api/tasks/71/artifacts/editing/final.mp4",
        title: "剪辑成片",
      }],
      extra: {
        editing: {
          mode: "intelligent",
          videoUrl: "/api/tasks/71/artifacts/editing/final.mp4",
          qaUrl: "/api/tasks/71/artifacts/editing/qa-summary.json",
          planUrl: "/api/tasks/71/artifacts/editing/edit-plan.json",
          plannerThreadId: "thread-secret",
          qa: { fullDecode: true },
          attentionNote: "  检查开头\n字幕和收尾 {raw}  ",
        },
      },
    }),
    error: null,
    asset_schedule_complete: 1,
    created_by: "employee",
    created_at: "2026-08-31T00:00:00Z",
    started_at: "2026-08-31T00:00:01Z",
    finished_at: "2026-08-31T00:00:02Z",
  });
  assert.deepEqual(task.params, {
    brief: "剪掉停顿",
    editMode: "digital_presenter",
    editTargetDuration: 15,
    editAspect: "vertical",
    editCaptions: "auto",
    captionStyle: "punchy",
    editAudio: "keep",
    transcribe: false,
    editVoice: "original",
    subtitleLanguage: "en",
  });
  assert.deepEqual(task.result, {
    message: "视频已经剪好",
    media: [{
      type: "video",
      url: "/api/tasks/71/artifacts/editing/final.mp4",
      title: "剪辑成片",
    }],
    extra: {
      editing: {
        videoUrl: "/api/tasks/71/artifacts/editing/final.mp4",
        attentionNote: "检查开头 字幕和收尾 raw",
      },
    },
  });
  const serialized = JSON.stringify(task);
  for (const secret of [
    "asset-secret-id",
    "secret label map",
    "thread-secret",
    "qa-summary.json",
    "edit-plan.json",
    "internal report",
  ]) {
    assert.equal(serialized.includes(secret), false, `must hide ${secret}`);
  }
});

test("employee delivery keeps requested narration and incomplete status visible", () => {
  const task = toTaskOut({id:340, feature_id:"auto_edit",params_json:JSON.stringify({editVoice:"narration"}),
    status:"succeeded",result_json:JSON.stringify({message:"配音合成未完成",extra:{editing:{
      videoUrl:"/api/tasks/340/artifacts/editing/final.mp4",narrationNote:"配音合成未完成；目前只能使用原声精剪版。",narrationStatus:"incomplete"}}})});
  assert.equal(task.params.editVoice,"narration");
  assert.equal(task.result.extra.editing.narrationStatus,"incomplete");
  assert.match(task.result.extra.editing.narrationNote,/未完成/);
});

test.after(async () => {
  const { db } = await import("../lib/db.ts");
  db.close();
  fs.rmSync(testData, { recursive: true, force: true });
});

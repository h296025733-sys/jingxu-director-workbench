import test from "node:test";
import assert from "node:assert/strict";
import { buildWatermarkOnlyPlan } from "../lib/watermark-only-plan.ts";

test("watermark-only plan keeps the full source and discards editing suggestions", () => {
  const plan = buildWatermarkOnlyPlan({
    draftPlan: { job_id: "mx-edit-999-123e4567-e89b-42d3-a456-426614174000" },
    analysis: {
      assets: [{
        kind: "video",
        job_path: "inputs/01_source.mp4",
        probe: {
          duration_seconds: 12.5,
          video: { width: 1080, height: 1920, fps: 29.97 },
          audio: { codec: "aac" },
        },
      }],
    },
    plannedPlan: {
      clips: [{ source: "inputs/01_source.mp4", start: 3, end: 8, speed: 1.4, mute: true }],
      overlays: [{ text: "do not keep" }],
      transitions: [{ type: "dissolve" }],
      music: { source: "inputs/music.mp3" },
      watermark_cleanup: {
        inspected: true,
        regions: [{
          source: "inputs/01_source.mp4",
          start: 0,
          end: 12.5,
          x: 0.83,
          y: 0.03,
          width: 0.12,
          height: 0.05,
          kind: "overlay_watermark",
          safe_to_remove: true,
          evidence_times: [0, 6, 12.5],
          evidence: "The same small account watermark remains fixed in clear sky across the full clip.",
        }],
      },
    },
  });

  assert.deepEqual(plan.clips, [{
    source: "inputs/01_source.mp4",
    kind: "video",
    visual_job: "bridge",
    selection_reason: "完整保留员工上传的唯一原视频，不执行剪辑取舍。",
    exit_condition: "原视频完整播放到自然结尾。",
    start: 0,
    end: 12.5,
    speed: 1,
    fit: "contain",
    audio_gain_db: 0,
    mute: false,
  }]);
  assert.deepEqual(plan.overlays, []);
  assert.deepEqual(plan.transitions, []);
  assert.equal(plan.music, null);
  assert.equal(plan.output.width, 1080);
  assert.equal(plan.output.height, 1920);
  assert.equal(plan.watermark_cleanup.regions.length, 1);
  assert.equal(plan.watermark_cleanup.regions[0].safe_to_remove, true);
});

test("watermark-only plan never removes product branding or uncertain marks", () => {
  const plan = buildWatermarkOnlyPlan({
    draftPlan: { job_id: "mx-edit-1000-123e4567-e89b-42d3-a456-426614174000" },
    analysis: {
      assets: [{
        kind: "video",
        job_path: "inputs/01_source.mp4",
        probe: { duration_seconds: 5, video: { width: 1920, height: 1080, fps: 60 } },
      }],
    },
    plannedPlan: {
      watermark_cleanup: {
        inspected: true,
        regions: [{
          source: "inputs/01_source.mp4", start: 0, end: 5,
          x: 0.2, y: 0.2, width: 0.1, height: 0.05,
          kind: "embedded_brand", safe_to_remove: true,
          evidence_times: [0, 5], evidence: "Visible product logo printed on the physical package.",
        }],
      },
    },
  });

  assert.deepEqual(plan.watermark_cleanup.regions, []);
});


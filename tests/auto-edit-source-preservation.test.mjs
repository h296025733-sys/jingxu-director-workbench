import assert from "node:assert/strict";
import test from "node:test";
import { preserveMainSourceAudio, summarizeEditSourceCoverage } from "../lib/auto-edit-source-preservation.ts";
import { validateEditingModePlan, normalizeEditingPlanParameters } from "../lib/codex-director.ts";
const sources = [{ source: "inputs/main.mp4", kind: "video", durationSeconds: 30 },
  { source: "inputs/support.mp4", kind: "video", durationSeconds: 4 }];
const clip = (source, start, end, speed = 1) => ({ source, kind: "video", start, end, speed, mute: true, audio_gain_db: 0 });

test("ASR gaps and accelerated mainline handling retain original sound without unmuting support", () => {
  const plan = { clips: [clip(sources[1].source, 0, 1), clip(sources[0].source, 0, 2.6, 1.25),
    clip(sources[0].source, 5.9, 8.85), clip(sources[0].source, 20.56, 24.73)],
    picture_in_picture: [{ source: sources[1].source, mute: true }] };
  const kept = preserveMainSourceAudio(plan, sources, "keep");
  assert.equal(kept.clips[0].mute, true);
  assert.equal(kept.clips.slice(1).every(c => !c.mute), true);
  assert.equal(kept.clips[1].speed, 1.25);
  assert.deepEqual(kept.picture_in_picture, plan.picture_in_picture);
  assert.equal(plan.clips[1].mute, true, "does not mutate the candidate or cached plan");
  assert.deepEqual(preserveMainSourceAudio(kept, sources, "keep"), kept);
});
test("explicit silent delivery and uncertain manifests are not overridden", () => {
  const plan = { clips: [clip(sources[0].source, 0, 4)] };
  assert.equal(preserveMainSourceAudio(plan, sources, "mute"), plan);
  assert.equal(preserveMainSourceAudio(plan, [], "keep"), plan);
});
test("near-silence gain cannot silently undo keep; ordinary mix gain is preserved", () => {
  const plan = { clips: [{ ...clip(sources[0].source, 0, 4), mute: false, audio_gain_db: -90 },
    { ...clip(sources[0].source, 4, 6), mute: false, audio_gain_db: -3 }] };
  const kept = preserveMainSourceAudio(plan, sources, "keep");
  assert.equal(kept.clips[0].audio_gain_db, 0);
  assert.equal(kept.clips[1].audio_gain_db, -3);
});
test("coverage exposes removed opening and unique source gaps without judging their semantics", () => {
  const summary = summarizeEditSourceCoverage({ clips: [clip(sources[0].source, 2.61, 5.93),
    clip(sources[0].source, 5.93, 8.85, 1.15), clip(sources[0].source, 9.51, 30)] }, sources)[0];
  assert.deepEqual(summary.omittedSourceRanges, [{ start: 0, end: 2.61 }, { start: 8.85, end: 9.51 }]);
  assert.equal(summary.retainedSourceRanges[1].speed, 1.15);
  assert.equal(summary.semanticValueOfOmissions, "not_measured");
});
test("overlapping or reordered source spans are unioned, not counted twice", () => {
  const summary = summarizeEditSourceCoverage({ clips: [clip(sources[0].source, 9, 15),
    clip(sources[0].source, 0, 10), clip(sources[0].source, 16, 30)] }, sources)[0];
  assert.deepEqual(summary.omittedSourceRanges, [{ start: 15, end: 16 }]);
});

test("a complete authored product story does not need a synthetic flash, zoom or transition", () => {
  const plan = { narrative_regime: "hybrid", clips: [
    { ...clip(sources[0].source, 0, 3), mute: false, visual_job: "hook" },
    { ...clip(sources[0].source, 3, 7), mute: false, visual_job: "feature" },
    { ...clip(sources[0].source, 7, 12), mute: false, visual_job: "proof" },
    { ...clip(sources[0].source, 12, 17), mute: false, visual_job: "payoff" },
  ], transitions: [], picture_in_picture: [], finishing: { preset: "none", flashes: [] }, overlays: [
    { kind: "title", start: 0.2, end: 1.5, text: "Watch this speaker", highlights: [], preset: "fine_hook", animation: "fade", effect_reason: "hook" },
    { kind: "caption", start: 3, end: 5, text: "One speaker two sides", highlights: [], preset: "fine_caption", animation: "fade", effect_reason: "readability" },
    { kind: "label", start: 8, end: 10, text: "two sides", highlights: [], preset: "feature", animation: "fade", effect_reason: "proof" },
    { kind: "title", start: 14, end: 16, text: "Back together", highlights: [], preset: "fine_hook", animation: "fade", effect_reason: "payoff" },
  ] };
  for (const clip of plan.clips) {
    clip.selection_reason = "The synthetic test fixture defines a complete product state in this interval.";
    clip.exit_condition = "This fixture's demonstrated state and spoken clause are complete.";
  }
  const params = normalizeEditingPlanParameters({ editMode: "smart", captionStyle: "punchy", editAudio: "keep" });
  assert.doesNotThrow(() => validateEditingModePlan(plan, params, ["Watch this speaker. One speaker two sides. Back together."]));
});

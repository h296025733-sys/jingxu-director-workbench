import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const LAB_ROOT = process.env.AUTO_VIDEO_LAB_ROOT || "D:\\workspace\\codex-auto-video-lab";
const PYTHON = path.join(LAB_ROOT, ".venv", "Scripts", "python.exe");
const FFMPEG = path.join(LAB_ROOT, "tools", "ffmpeg", "bin", "ffmpeg.exe");
const FFPROBE = path.join(LAB_ROOT, "tools", "ffmpeg", "bin", "ffprobe.exe");
const DETECTOR = path.join(PROJECT_ROOT, "tools", "measure_in_frame_roll.py");
const WORK = mkdtempSync(path.join(tmpdir(), "mirror-roll-test-"));

test.after(() => rmSync(WORK, { recursive: true, force: true }));

function run(executable, args) {
  return execFileSync(executable, args, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function ffmpeg(args) {
  run(FFMPEG, ["-hide_banner", "-loglevel", "error", ...args]);
}

function detect(input, range = {}) {
  const args = [
    DETECTOR,
    "--input", input,
    "--ffmpeg", FFMPEG,
    "--ffprobe", FFPROBE,
  ];
  if (range.start !== undefined) args.push("--start", String(range.start));
  if (range.end !== undefined) args.push("--end", String(range.end));
  const stdout = run(PYTHON, args).trim();
  const payload = JSON.parse(stdout);
  assert.deepEqual(Object.keys(payload).sort(), ["sampleCount", "segments"]);
  assert.equal(Array.isArray(payload.segments), true);
  assert.equal(Number.isInteger(payload.sampleCount), true);
  return payload;
}

const base = path.join(WORK, "base.png");
const upright = path.join(WORK, "upright.mp4");
const sustained = path.join(WORK, "sustained-roll.mp4");
const brief = path.join(WORK, "brief-roll.mp4");
const displayMatrix = path.join(WORK, "display-matrix.mp4");

ffmpeg([
  "-f", "lavfi", "-i", "testsrc2=size=960x960:rate=1:duration=1",
  "-frames:v", "1", "-y", base,
]);

function createVideo(output, videoFilter) {
  ffmpeg([
    "-loop", "1", "-framerate", "30", "-i", base, "-t", "4",
    "-vf", videoFilter,
    "-an", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-y", output,
  ]);
}

createVideo(upright, "crop=640:360");
createVideo(
  sustained,
  "rotate='if(lt(t,1),0,if(lt(t,1.5),(t-1)*2*0.872665,if(lt(t,2.5),0.872665,if(lt(t,3),(3-t)*2*0.872665,0))))':ow=iw:oh=ih:fillcolor=black,crop=640:360",
);
createVideo(
  brief,
  "rotate='if(lt(t,1),0,if(lt(t,1.15),(t-1)/0.15*0.872665,if(lt(t,1.3),0.872665,if(lt(t,1.45),(1.45-t)/0.15*0.872665,0))))':ow=iw:oh=ih:fillcolor=black,crop=640:360",
);
ffmpeg([
  "-display_rotation", "90", "-i", upright,
  "-map", "0", "-c", "copy", "-y", displayMatrix,
]);

test("detects at least 35 degrees of in-frame roll held for 0.4 seconds", () => {
  const result = detect(sustained);
  assert.equal(result.sampleCount, 60);
  assert.equal(result.segments.length, 1);
  const segment = result.segments[0];
  assert.ok(segment.start >= 1.35 && segment.start <= 1.8, segment.start);
  assert.ok(segment.end >= 2.4 && segment.end <= 2.9, segment.end);
  assert.ok(segment.maxAbsDegrees >= 35 && segment.maxAbsDegrees <= 65, segment.maxAbsDegrees);
  assert.ok(segment.confidence >= 0.5 && segment.confidence <= 1, segment.confidence);
});

test("does not report upright video or a sub-0.4-second roll", () => {
  assert.deepEqual(detect(upright).segments, []);
  assert.deepEqual(detect(brief).segments, []);
});

test("FFmpeg autorotation prevents a static display matrix from becoming an in-frame hit", () => {
  const probe = JSON.parse(run(FFPROBE, [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream_side_data=rotation", "-of", "json", displayMatrix,
  ]));
  assert.equal(probe.streams[0].side_data_list[0].rotation, 90);
  assert.deepEqual(detect(displayMatrix).segments, []);
});

test("optional start/end retain absolute source timestamps", () => {
  const full = detect(sustained);
  const partial = detect(sustained, { start: 0.5, end: 3.5 });
  assert.ok(partial.sampleCount < full.sampleCount);
  assert.equal(partial.segments.length, 1);
  assert.ok(partial.segments[0].start >= 1.35, partial.segments[0].start);
  assert.ok(partial.segments[0].end <= 2.9, partial.segments[0].end);
});

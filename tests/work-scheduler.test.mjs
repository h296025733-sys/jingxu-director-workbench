import assert from "node:assert/strict";
import test from "node:test";

test("未来配音工作共享总队列，最多一路且与同员工导演串行", async () => {
  const { enqueueWork, workSchedulerSnapshot } = await import('../lib/work-scheduler.ts');
  let voices = 0; let maximum = 0; const events = [];
  await new Promise((resolve) => {
    let done = 0;
    for (const [id, owner, kind] of [['voice-one','owner-v1','voice'],['voice-two','owner-v2','voice'],['director-one','owner-v1','director']]) {
      enqueueWork({ id, owner, kind, priority: 1, run: async () => {
        events.push(id + ':start');
        if (kind === 'voice') { voices++; maximum = Math.max(maximum, voices); }
        await new Promise(end => setTimeout(end, 20));
        if (kind === 'voice') voices--;
        events.push(id + ':end');
        if (++done === 3) resolve();
      } });
    }
  });
  await new Promise(end => setTimeout(end, 0));
  assert.equal(maximum, 1);
  assert.ok(events.indexOf('director-one:start') > events.indexOf('voice-one:end'));
  assert.equal(workSchedulerSnapshot().voiceConcurrency, 1);
  assert.equal(workSchedulerSnapshot().active.length, 0);
});

test("跨员工并发、同员工串行，并限制两路参考视频处理", async () => {
  process.env.DW_CODEX_CONCURRENCY = "4";
  const { enqueueWork, workSchedulerSnapshot } = await import(
    `../lib/work-scheduler.ts?test=${Date.now()}`
  );

  const starts = [];
  const activeOwners = new Set();
  let activeCount = 0;
  let activeReferenceVideos = 0;
  let maxActive = 0;
  let maxReferenceVideos = 0;
  let sameOwnerOverlap = false;

  const jobs = [
    ["a-director", "a", "director", 1, 45],
    ["a-image", "a", "image", 1, 10],
    ["a-auto-video", "a", "reference_video", 2, 10],
    ["b-understanding", "b", "understanding", 0, 35],
    ["b-image", "b", "image", 1, 10],
    ["c-video", "c", "reference_video", 1, 35],
    ["d-video", "d", "reference_video", 1, 20],
    ["e-image", "e", "image", 1, 20],
  ];

  await new Promise((resolve, reject) => {
    let completed = 0;
    for (const [id, owner, kind, priority, duration] of jobs) {
      const accepted = enqueueWork({
        id,
        owner,
        kind,
        priority,
        run: async () => {
          starts.push(id);
          if (activeOwners.has(owner)) sameOwnerOverlap = true;
          activeOwners.add(owner);
          activeCount += 1;
          if (kind === "reference_video") activeReferenceVideos += 1;
          maxActive = Math.max(maxActive, activeCount);
          maxReferenceVideos = Math.max(
            maxReferenceVideos,
            activeReferenceVideos,
          );
          await new Promise((done) => setTimeout(done, duration));
          if (kind === "reference_video") activeReferenceVideos -= 1;
          activeCount -= 1;
          activeOwners.delete(owner);
          completed += 1;
          if (completed === jobs.length) resolve();
        },
      });
      if (!accepted) reject(new Error(`job rejected: ${id}`));
    }
  });

  assert.equal(sameOwnerOverlap, false);
  assert.equal(maxActive, 4);
  assert.equal(maxReferenceVideos <= 2, true);
  assert.deepEqual(
    starts.filter((id) => id.startsWith("a-")),
    ["a-director", "a-image", "a-auto-video"],
  );
  assert.deepEqual(
    starts.filter((id) => id.startsWith("b-")),
    ["b-understanding", "b-image"],
  );
  assert.equal(starts.indexOf("d-video") < starts.indexOf("b-image"), true);
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(workSchedulerSnapshot().active, []);
  assert.deepEqual(workSchedulerSnapshot().queued, []);
});

test("支持显式降到一路剪辑、四路全站工作的兼容配置", async () => {
  process.env.DW_CODEX_CONCURRENCY = "4";
  process.env.DW_EDITING_CONCURRENCY = "1";
  const { enqueueWork, workSchedulerSnapshot } = await import(
    `../lib/work-scheduler.ts?editing=${Date.now()}`
  );
  let active = 0;
  let activeEditing = 0;
  let maxActive = 0;
  let maxEditing = 0;
  let maxOtherWhileEditing = 0;
  const jobs = [
    ["edit-a", "edit-owner-a", "editing", 55],
    ["edit-b", "edit-owner-b", "editing", 25],
    ["director-a", "director-owner-a", "director", 45],
    ["director-b", "director-owner-b", "director", 45],
    ["director-c", "director-owner-c", "director", 45],
    ["director-d", "director-owner-d", "director", 20],
    ["image-a", "image-owner-a", "image", 20],
  ];

  await new Promise((resolve, reject) => {
    let completed = 0;
    for (const [id, owner, kind, duration] of jobs) {
      const accepted = enqueueWork({
        id,
        owner,
        kind,
        priority: kind === "editing" ? 2 : 1,
        run: async () => {
          active += 1;
          if (kind === "editing") activeEditing += 1;
          maxActive = Math.max(maxActive, active);
          maxEditing = Math.max(maxEditing, activeEditing);
          if (activeEditing > 0) {
            maxOtherWhileEditing = Math.max(
              maxOtherWhileEditing,
              active - activeEditing,
            );
          }
          await new Promise((done) => setTimeout(done, duration));
          if (kind === "editing") activeEditing -= 1;
          active -= 1;
          completed += 1;
          if (completed === jobs.length) resolve();
        },
      });
      if (!accepted) reject(new Error(`job rejected: ${id}`));
    }
  });

  assert.equal(maxActive, 4);
  assert.equal(maxEditing, 1);
  assert.equal(maxOtherWhileEditing <= 3, true);
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(workSchedulerSnapshot().active, []);
  assert.deepEqual(workSchedulerSnapshot().queued, []);
});

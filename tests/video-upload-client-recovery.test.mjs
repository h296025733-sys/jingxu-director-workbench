import assert from "node:assert/strict";
import test from "node:test";
import { cleanupVideoUploadSession, uploadVideoFile } from "../lib/video-client.ts";

function browser() {
  const storage = new Map();
  return Object.assign(new EventTarget(), {
    location: { hostname: "mirror.example.com", origin: "https://mirror.example.com" },
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  });
}

test("cleanup retries a busy/failed DELETE until the server acknowledges it", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.window = browser();
  const statuses = [409, 503, 200];
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    assert.equal(init.method, "DELETE");
    assert.equal(init.keepalive, true);
    return new Response("{}", { status: statuses[calls++] });
  };
  try {
    assert.equal(await cleanupVideoUploadSession("fixture-id"), true);
    assert.equal(calls, 3);
  } finally { globalThis.fetch = originalFetch; delete globalThis.window; }
});

test("failed cleanup is remembered and repaired before another upload is initialized", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.window = browser();
  const id = "00000000-0000-4000-8000-000000000001";
  let deletingWorks = false;
  let repaired = false;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("github.io")) return Response.json({ url: window.location.origin });
    if (init.method === "DELETE") {
      if (String(url).endsWith(id) && deletingWorks) repaired = true;
      return Response.json({}, { status: deletingWorks ? 200 : 503 });
    }
    assert.equal(repaired, true);
    return Response.json({ error: "test stop", code: "UPLOAD_USER_BUSY" }, { status: 429 });
  };
  try {
    assert.equal(await cleanupVideoUploadSession(id), false);
    assert.ok(window.localStorage.getItem("jingxu:failed-upload-cleanup:v1").includes(id));
    deletingWorks = true;
    await assert.rejects(uploadVideoFile(new File(["x"], "test.mp4")), /test stop/);
    assert.equal(window.localStorage.getItem("jingxu:failed-upload-cleanup:v1"), "[]");
  } finally { globalThis.fetch = originalFetch; delete globalThis.window; }
});

test("public upload negotiates 1 MiB, retries only missing chunks and cleans the session", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.window = browser();
  const attempts = new Map();
  let sessionId;
  let cleanupCount = 0;
  const progress = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("github.io")) return Response.json({ url: window.location.origin });
    if (init.method === "DELETE") { cleanupCount++; return Response.json({}); }
    if (String(url).endsWith("/complete")) {
      assert.deepEqual([...attempts.values()].sort(), [1, 1, 2]);
      return Response.json({ video: { id: "saved-fixture" } });
    }
    const body = JSON.parse(init.body);
    sessionId = body.idempotencyKey;
    assert.equal(body.chunkSize, 1048576);
    assert.equal(body.purpose, "voice_reference");
    return Response.json({ session: { id: sessionId, totalSize: body.size, chunkSize: body.chunkSize, chunkCount: 3 } });
  };
  globalThis.XMLHttpRequest = class {
    upload = {};
    open(_method, url) { this.index = Number(url.split("/").at(-1)); }
    setRequestHeader() {}
    abort() { this.onabort?.(); }
    send(blob) {
      queueMicrotask(() => {
        const count = (attempts.get(this.index) || 0) + 1;
        attempts.set(this.index, count);
        this.upload.onprogress({ loaded: blob.size });
        this.status = this.index === 0 && count === 1 ? 503 : 200;
        this.responseText = this.status === 503 ? '{"error":"temporary failure"}' : '{}';
        void this.onload();
      });
    }
  };
  try {
    const result = await uploadVideoFile(
      new File([new Uint8Array(3 * 1048576)], "voice.wav"),
      p => progress.push(p),
      undefined,
      "voice_reference",
    );
    assert.equal(result.id, "saved-fixture");
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(cleanupCount >= 1);
    assert.ok(progress.some(p => p.statusText?.includes("降低并发")));
    assert.ok(progress.at(-1).phase === "saving");
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.XMLHttpRequest;
    delete globalThis.window;
  }
});

test("capacity rejection is not relabeled as a network error or retried four times", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.window = browser();
  let postCount = 0;
  let cleanupCount = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("github.io")) return Response.json({ url: window.location.origin });
    if (init.method === "DELETE") { cleanupCount++; return Response.json({}); }
    postCount++;
    return Response.json({ error: "已有 2 个视频正在上传", code: "UPLOAD_USER_BUSY" }, { status: 429 });
  };
  try {
    await assert.rejects(uploadVideoFile(new File(["x"], "test.mp4")), /已有 2 个视频/);
    assert.equal(postCount, 1);
    assert.equal(cleanupCount, 1, "initialization ID is retained even without a successful response");
  } finally { globalThis.fetch = originalFetch; delete globalThis.window; }
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test, { after } from "node:test";

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "jingxu-upload-recovery-"));
process.env.DW_TEST_DATA_DIR = fixture;
const { db } = await import("../lib/db.ts");
const uploads = await import("../lib/video-upload-sessions.ts");
const { currentVideoUploadCapacity } = await import("../lib/video-upload-limits.ts");
const { receiveVideoUploadChunk } = await import("../lib/video-upload-stream.ts");
after(() => {
  db.close();
  assert.ok(path.resolve(fixture).startsWith(path.join(os.tmpdir(), "jingxu-upload-recovery-")));
  fs.rmSync(fixture, { recursive: true, force: true });
});

function session({ username = "alice", status = "active", age = 0, bytes = 0 } = {}) {
  const id = crypto.randomUUID();
  const time = new Date(Date.now() - age).toISOString();
  db.prepare("INSERT INTO video_upload_sessions (id,original_name,total_size,chunk_size,chunk_count,uploaded_by,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, "fixture.mp4", 1024, 1024, 1, username, status, time, time);
  uploads.createVideoUploadSessionDirectory(id);
  fs.writeFileSync(uploads.videoUploadChunkPath(id, 0, true), Buffer.alloc(bytes));
  return id;
}

test("abort returns and closes the file even when the network stream's cancellation never settles", async () => {
  const controller = new AbortController();
  const destination = path.join(fixture, "stalled-body.part");
  const body = new ReadableStream({
    start(stream) { stream.enqueue(new Uint8Array([1, 2, 3])); },
    cancel() { return new Promise(() => {}); },
  });
  let observed;
  const written = new Promise(resolve => { observed = resolve; });
  const receiving = receiveVideoUploadChunk(body, destination, 1024, controller.signal, observed);
  await written;
  controller.abort();
  await assert.rejects(Promise.race([
    receiving,
    new Promise((_resolve, reject) => { const t = setTimeout(() => reject(new Error("Cancellation stuck")), 1000); t.unref(); }),
  ]), error => error.name === "AbortError");
  fs.rmSync(destination); // On Windows this proves that the file handle closed.
});

test("stream receiver writes the exact payload and rejects oversized bodies", async () => {
  const destination = path.join(fixture, "bounded-body.part");
  const data = new Uint8Array([1, 2, 3, 4]);
  const received = await receiveVideoUploadChunk(new Blob([data]).stream(), destination, 4, new AbortController().signal, () => {});
  assert.equal(received, 4);
  assert.deepEqual(fs.readFileSync(destination), Buffer.from(data));
  await assert.rejects(receiveVideoUploadChunk(new Blob([data]).stream(), `${destination}.large`, 3, new AbortController().signal, () => {}), /CHUNK_TOO_LARGE/);
});

test("cancellation releases capacity, aborts every stream, and waits for writers before deleting", () => {
  const id = session();
  const first = new AbortController();
  const second = new AbortController();
  const releaseFirst = uploads.beginVideoUploadChunkWrite(id, 0, first);
  const releaseSecond = uploads.beginVideoUploadChunkWrite(id, 1, second);
  assert.equal(uploads.beginVideoUploadChunkWrite(id, 0, new AbortController()), null);
  assert.equal(currentVideoUploadCapacity("alice").userCount, 1);
  assert.equal(uploads.cancelVideoUploadSession(id), true);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(currentVideoUploadCapacity("alice").userCount, 0);
  assert.equal(uploads.findVideoUploadSession(id).status, "canceled");
  releaseFirst();
  assert.equal(fs.existsSync(uploads.videoUploadSessionDirectory(id)), true);
  releaseSecond();
  assert.equal(uploads.findVideoUploadSession(id), undefined);
  assert.equal(fs.existsSync(uploads.videoUploadSessionDirectory(id)), false);
  releaseSecond(); // Idempotent release cannot corrupt another writer's lock.
});

test("an assembling upload cannot be canceled out from under a saved-video response", () => {
  const id = session({ status: "assembling" });
  assert.equal(uploads.cancelVideoUploadSession(id), false);
  assert.equal(uploads.findVideoUploadSession(id).status, "assembling");
});

test("new upload reclaims only this user's old empty inactive reservations", () => {
  const stale = session({ age: 180_000 });
  const recent = session();
  const partial = session({ age: 180_000, bytes: 16 });
  const other = session({ username: "bob", age: 180_000 });
  const receiving = session({ age: 180_000 });
  const release = uploads.beginVideoUploadChunkWrite(receiving, 0, new AbortController());
  uploads.cleanupAbandonedEmptyVideoUploads("alice");
  assert.equal(uploads.findVideoUploadSession(stale), undefined);
  for (const id of [recent, partial, other, receiving]) assert.ok(uploads.findVideoUploadSession(id));
  release();
});

test("persisted cancellation is recoverable even after process-local stream state is lost", () => {
  const id = session({ status: "canceled", bytes: 15 });
  assert.equal(uploads.finishCanceledVideoUpload(id), true);
  assert.equal(fs.existsSync(uploads.videoUploadSessionDirectory(id)), false);
});

test("removing completed-session bookkeeping never deletes the finished video", () => {
  const id = session({ status: "completed" });
  const videoId = crypto.randomUUID();
  const videoPath = path.join(fixture, "videos", `${videoId}.mp4`);
  fs.writeFileSync(videoPath, Buffer.from("preserve-saved-video"));
  db.prepare("INSERT INTO videos (id, original_name, stored_name, mime_type, size_bytes, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(videoId, "saved.mp4", `${videoId}.mp4`, "video/mp4", 20, "alice", new Date().toISOString());
  db.prepare("UPDATE video_upload_sessions SET video_id=? WHERE id=?").run(videoId, id);
  assert.equal(uploads.cancelVideoUploadSession(id), true);
  assert.equal(uploads.findVideoUploadSession(id), undefined);
  assert.ok(db.prepare("SELECT id FROM videos WHERE id=?").get(videoId));
  assert.equal(fs.readFileSync(videoPath, "utf8"), "preserve-saved-video");
});

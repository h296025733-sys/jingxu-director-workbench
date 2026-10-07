import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";

const baseUrl = String(process.argv[2] || "").replace(/\/$/, "");
const fixturePath = String(process.argv[3] || "");
const password = String(process.argv[4] || "");
if (!baseUrl || !fixturePath || !password) {
  throw new Error("Usage: node video-upload-api-e2e.mjs <base-url> <video> <password>");
}

async function json(response, expectedStatus = 200) {
  const text = await response.text();
  assert.equal(
    response.status,
    expectedStatus,
    `${response.status} ${response.url}: ${text.slice(0, 300)}`,
  );
  const parsed = JSON.parse(text);
  assert.equal(typeof parsed, "object");
  return parsed;
}

const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "admin", password }),
});
await json(loginResponse);
const cookie = loginResponse.headers.getSetCookie()[0]?.split(";", 1)[0];
assert.ok(cookie, "login response must set an auth cookie");

const file = fs.readFileSync(fixturePath);
const idempotencyKey = crypto.randomUUID();
const sessionRequest = () =>
  fetch(`${baseUrl}/api/videos/upload-sessions`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "upload-e2e.mp4",
      size: file.length,
      idempotencyKey,
    }),
  });

const initialized = await json(await sessionRequest());
const retriedInitialization = await json(await sessionRequest());
assert.deepEqual(retriedInitialization.session, initialized.session);
const { id, chunkSize, chunkCount, totalSize } = initialized.session;
assert.equal(id, idempotencyKey);
assert.equal(chunkSize, 8 * 1024 * 1024);
assert.equal(totalSize, file.length);
assert.equal(chunkCount, Math.ceil(file.length / chunkSize));
assert.ok(chunkCount >= 2, "fixture must exercise multiple chunks");

async function putChunk(index) {
  const start = index * chunkSize;
  const end = Math.min(file.length, start + chunkSize);
  const response = await fetch(
    `${baseUrl}/api/videos/upload-sessions/${id}/chunks/${index}`,
    {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/octet-stream" },
      body: file.subarray(start, end),
    },
  );
  return json(response);
}

await Promise.all(Array.from({ length: chunkCount }, (_value, index) => putChunk(index)));
const repeatedChunk = await putChunk(0);
assert.equal(repeatedChunk.index, 0);

async function completeWithRetry() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(
      `${baseUrl}/api/videos/upload-sessions/${id}/complete`,
      { method: "POST", headers: { Cookie: cookie } },
    );
    if (response.status === 409) {
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    return json(response);
  }
  throw new Error("video completion did not settle in time");
}

const [firstCompletion, repeatedCompletion] = await Promise.all([
  completeWithRetry(),
  completeWithRetry(),
]);
assert.equal(firstCompletion.video.id, repeatedCompletion.video.id);

const library = await json(
  await fetch(`${baseUrl}/api/videos`, { headers: { Cookie: cookie } }),
);
assert.equal(
  library.videos.filter((video) => video.id === firstCompletion.video.id).length,
  1,
  "idempotent completion must create exactly one video",
);

await json(
  await fetch(`${baseUrl}/api/videos/${firstCompletion.video.id}`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  }),
);

console.log(
  JSON.stringify({
    ok: true,
    bytes: file.length,
    chunkSize,
    chunkCount,
    videoId: firstCompletion.video.id,
  }),
);

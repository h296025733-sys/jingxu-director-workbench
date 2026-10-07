import assert from "node:assert/strict";
import test from "node:test";
import { isTransientGenerationError, withTransientGenerationRetry, recoverGeneratedOutput } from "../lib/generation-recovery.ts";

test("retry only temporary transport/rate faults, never quota/auth/policy/isolation", () => {
  for (const message of ["stream disconnected before completion", "ECONNRESET", "502 Bad Gateway", "429 too many requests", "request failed: fetch failed", "IMAGE_NOT_PRODUCED: no file received", "参考图请求超时，本轮未收到图片", "请求超时，本轮导演生成未完成", "Selected model is at capacity. Please try a different model."]) {
    assert.equal(isTransientGenerationError(new Error(message)), true, message);
  }
  for (const message of ["You've hit your usage limit; try again next week", "429 insufficient_quota", "authentication expired", "content policy refusal", "图像服务拒绝：本次请求被拒绝", "Codex isolation contract violation: connection closed", "Codex isolated process tree did not close safely", "已取消", "unknown error"]) {
    assert.equal(isTransientGenerationError(new Error(message)), false, message);
  }
});

test("transient retry returns third successful response without duplicate jobs", async () => {
  const attempts = [], notices = [];
  const output = await withTransientGenerationRetry(async (attempt) => {
    attempts.push(attempt);
    if (attempt < 3) throw new Error("ECONNRESET");
    return "real-response-fixture";
  }, { delayMs: 0, onRetry: (attempt) => notices.push(attempt) });
  assert.equal(output, "real-response-fixture");
  assert.deepEqual(attempts, [1, 2, 3]);
  assert.deepEqual(notices, [2, 3]);
});

test("retries have a hard limit and cancellation stops backoff", async () => {
  let calls = 0;
  await assert.rejects(withTransientGenerationRetry(async () => {
    calls++; throw new Error("ECONNRESET");
  }, { delayMs: 0, maxAttempts: 100 }), /ECONNRESET/u);
  assert.equal(calls, 3);
  const controller = new AbortController();
  calls = 0;
  await assert.rejects(withTransientGenerationRetry(async () => {
    calls++; throw new Error("ECONNRESET");
  }, { signal: controller.signal, delayMs: 100, onRetry: () => controller.abort(new Error("user canceled")) }), /canceled/u);
  assert.equal(calls, 1);
});

const repairError = (issues) => Object.assign(new Error(issues.join(",")), { issues });
const issuesFromError = (error) => error.issues ?? null;

test("successive local metadata and binding faults need no extra model call", async () => {
  let calls = 0;
  const original = { character: "baby", metadata: false, binding: false };
  const result = await recoverGeneratedOutput({
    initial: original,
    validate(candidate) {
      if (!candidate.metadata) throw repairError(["metadata"]);
      if (!candidate.binding) throw repairError(["binding"]);
      return candidate;
    },
    issuesFromError,
    repairDeterministically: (candidate, issues) => ({ ...candidate, [issues[0]]: true }),
    repair: async () => { calls++; throw new Error("must not call model"); },
  });
  assert.deepEqual(result, { character: "baby", metadata: true, binding: true });
  assert.equal(calls, 0);
  assert.equal(original.metadata, false);
});

test("structural then semantic faults repair within same task; checkpoint preserves draft", async () => {
  const attempts = [], checkpoints = [];
  const result = await recoverGeneratedOutput({
    initial: "invalid JSON draft",
    validate(candidate) {
      if (typeof candidate === "string") throw repairError(["structure"]);
      if (!candidate.image) throw repairError(["missing identity"]);
      return candidate;
    }, issuesFromError,
    repairDeterministically: (candidate) => candidate,
    checkpoint: (candidate, issues) => checkpoints.push({ candidate, issues }),
    repair: async (_candidate, _issues, attempt) => {
      attempts.push(attempt);
      return { character: "baby", image: attempt >= 2 };
    },
  });
  assert.deepEqual(result, { character: "baby", image: true });
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(checkpoints[0].candidate, "invalid JSON draft");
});

test("recovery never returns an unvalidated draft or hides permanent failure", async () => {
  let calls = 0;
  await assert.rejects(recoverGeneratedOutput({
    initial: {}, validate: () => { throw repairError(["missing product truth"]); }, issuesFromError,
    repairDeterministically: (candidate) => ({ ...candidate }),
    repair: async () => { calls++; return {}; }, maxRepairs: 100,
  }), /missing product truth/u);
  assert.equal(calls, 4);
  await assert.rejects(recoverGeneratedOutput({
    initial: {}, validate: () => { throw new Error("auth error"); }, issuesFromError,
    repairDeterministically: (candidate) => candidate,
    repair: async () => { throw new Error("should never happen"); },
  }), /auth error/u);
});

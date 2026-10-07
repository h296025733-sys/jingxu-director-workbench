import assert from "node:assert/strict";
import test from "node:test";
import {
  isRetryableUploadStatus,
  isRetryableUploadFailure,
  parseUploadResponseBody,
  shouldUseResumableVideoUpload,
} from "../lib/video-upload-client-policy.ts";

test("公网域名始终使用可重试分块上传", () => {
  for (const hostname of [
    "exact-preventing-ears-evaluating.trycloudflare.com",
    "mirror.example.com",
    "workbench.example.cn",
    "stable-proxy.workers.dev",
  ]) {
    assert.equal(shouldUseResumableVideoUpload(hostname), true, hostname);
  }
});

test("明确的容量占用不是需要重复网络请求的故障", () => {
  assert.equal(isRetryableUploadFailure(429, "UPLOAD_USER_BUSY"), false);
  assert.equal(isRetryableUploadFailure(429, "UPLOAD_SERVER_BUSY"), false);
  assert.equal(isRetryableUploadFailure(429), true);
  assert.equal(isRetryableUploadFailure(503), true);
});

test("本机和局域网继续使用低开销直传", () => {
  for (const hostname of [
    "localhost",
    "127.0.0.1",
    "192.168.1.117",
    "10.0.0.8",
    "172.20.4.2",
    "daoyan.local",
    "OFFICE-PC",
    "::1",
  ]) {
    assert.equal(shouldUseResumableVideoUpload(hostname), false, hostname);
  }
});

test("Cloudflare HTML、空响应和合法 JSON 被明确区分", () => {
  assert.deepEqual(parseUploadResponseBody(""), { kind: "empty" });
  assert.deepEqual(parseUploadResponseBody("<!doctype html><title>Bad gateway</title>"), {
    kind: "html",
  });
  assert.deepEqual(parseUploadResponseBody("not-json"), { kind: "invalid" });
  assert.deepEqual(parseUploadResponseBody('{"error":"暂时失败"}'), {
    kind: "json",
    value: { error: "暂时失败" },
  });
});

test("只把网络波动和服务忙状态列为可重试", () => {
  for (const status of [0, 408, 409, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isRetryableUploadStatus(status), true, String(status));
  }
  for (const status of [400, 401, 403, 404, 413, 415, 422]) {
    assert.equal(isRetryableUploadStatus(status), false, String(status));
  }
});

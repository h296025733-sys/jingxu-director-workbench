import assert from "node:assert/strict";
import test from "node:test";
import {
  expectedUploadReferences,
  uploadReferenceKind,
} from "../lib/upload-reference.mjs";

test("图片和视频的 @ 编号分别从 1 开始", () => {
  assert.deepEqual(
    expectedUploadReferences(["image", "generated", "video"]),
    ["@图片1", "@图片2", "@视频1"],
  );
});

test("同类型引用保持连续，媒体切换不共享计数器", () => {
  assert.deepEqual(
    expectedUploadReferences([
      "video",
      "image",
      "audio",
      "video",
      "generated",
      "audio",
    ]),
    ["@视频1", "@图片1", "@音频1", "@视频2", "@图片2", "@音频2"],
  );
});

test("generated 素材在 Seedance 界面中按图片计数", () => {
  assert.equal(uploadReferenceKind("generated"), "图片");
});

test("未知媒体类型必须失败", () => {
  assert.throws(() => expectedUploadReferences(["document"]));
});

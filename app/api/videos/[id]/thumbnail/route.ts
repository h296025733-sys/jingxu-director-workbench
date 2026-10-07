import fs from "node:fs";
import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { fail, ok, readJson, withAuth } from "@/lib/api";
import {
  deleteThumbnail,
  getThumbnailPath,
  saveThumbnail,
} from "@/lib/storage";
import { canManageVideo } from "@/lib/permissions";
import type { VideoRow } from "@/lib/types";
import {
  fileEntityTag,
  ifNoneMatchMatches,
  privateRevalidationHeaders,
} from "@/lib/http-file-response";

type Ctx = { params: Promise<{ id: string }> };

const CONTENT_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

const VIDEO_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validVideoId(id: string): boolean {
  return VIDEO_ID_PATTERN.test(id);
}

export const GET = withAuth<Ctx>(async (req, ctx, user) => {
  const { id } = await ctx.params;
  if (!validVideoId(id)) return fail("视频编号无效", 400);
  const row = db
    .prepare("SELECT * FROM videos WHERE id = ?")
    .get(id) as unknown as VideoRow | undefined;
  if (!row) return fail("视频不存在", 404);
  if (!canManageVideo(user, row.uploaded_by)) return fail("视频不存在", 404);

  const thumbPath = getThumbnailPath(id);
  if (!thumbPath) return fail("缩略图不存在", 404);
  const ext = thumbPath.split(".").pop() ?? "jpg";
  const stat = fs.statSync(thumbPath);
  const etag = fileEntityTag(stat);
  const revalidationHeaders = privateRevalidationHeaders(stat, etag);
  if (ifNoneMatchMatches(req.headers.get("if-none-match"), etag)) {
    return new Response(null, {
      status: 304,
      headers: revalidationHeaders,
    });
  }
  const stream = Readable.toWeb(
    fs.createReadStream(thumbPath),
  ) as unknown as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: {
      ...revalidationHeaders,
      "Content-Type": CONTENT_TYPE[ext] ?? "image/jpeg",
      "Content-Length": String(stat.size),
    },
  });
});

export const POST = withAuth<Ctx>(async (req, ctx, user) => {
  const { id } = await ctx.params;
  if (!validVideoId(id)) return fail("视频编号无效", 400);
  const row = db
    .prepare("SELECT * FROM videos WHERE id = ?")
    .get(id) as unknown as VideoRow | undefined;
  if (!row) return fail("视频不存在", 404);
  if (!canManageVideo(user, row.uploaded_by)) {
    return fail("只能修改自己上传视频的缩略图", 403);
  }

  const body = await readJson(req, 8 * 1024 * 1024);
  const dataUrl = String(body.dataUrl ?? "");
  try {
    saveThumbnail(id, dataUrl);
  } catch (err) {
    return fail(err instanceof Error ? err.message : "保存缩略图失败", 400);
  }
  return ok({ message: "缩略图已保存" });
});

export const DELETE = withAuth<Ctx>(async (_req, ctx, user) => {
  const { id } = await ctx.params;
  if (!validVideoId(id)) return fail("视频编号无效", 400);
  const row = db
    .prepare("SELECT * FROM videos WHERE id = ?")
    .get(id) as unknown as VideoRow | undefined;
  if (!row) return fail("视频不存在", 404);
  if (!canManageVideo(user, row.uploaded_by)) {
    return fail("只能删除自己上传视频的缩略图", 403);
  }
  deleteThumbnail(id);
  return ok({ message: "已删除缩略图" });
});

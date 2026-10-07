import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { fail, withAuth } from "@/lib/api";
import { getAssetPath, mimeForImageExt } from "@/lib/storage";
import type { AssetRow } from "@/lib/types";
import {
  fileEntityTag,
  ifNoneMatchMatches,
  privateRevalidationHeaders,
} from "@/lib/http-file-response";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withAuth<Ctx>(async (req, ctx, user) => {
  const { id } = await ctx.params;
  const row = db
    .prepare("SELECT * FROM assets WHERE id = ?")
    .get(id) as unknown as AssetRow | undefined;
  if (!row) return fail("参考图片不存在", 404);
  if (!user.isAdmin && row.uploaded_by !== user.username) {
    return fail("参考图片不存在", 404);
  }

  const filePath = getAssetPath(row.stored_name);
  if (!fs.existsSync(filePath)) return fail("参考图片文件已丢失", 404);

  const contentType = mimeForImageExt(
    path.extname(row.stored_name).toLowerCase(),
  );
  if (contentType === "application/octet-stream") {
    return fail("参考图片格式无效", 404);
  }

  const stat = fs.statSync(filePath);
  const etag = fileEntityTag(stat);
  const revalidationHeaders = privateRevalidationHeaders(stat, etag);
  if (ifNoneMatchMatches(req.headers.get("if-none-match"), etag)) {
    return new Response(null, {
      status: 304,
      headers: revalidationHeaders,
    });
  }
  const stream = Readable.toWeb(
    fs.createReadStream(filePath),
  ) as unknown as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: {
      ...revalidationHeaders,
      "Content-Type": contentType,
      "Content-Length": String(stat.size),
    },
  });
});

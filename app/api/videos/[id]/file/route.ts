import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getVideoPath, mimeForExt } from "@/lib/storage";
import { fail } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import type { VideoRow } from "@/lib/types";
import { canManageVideo } from "@/lib/permissions";
import {
  fileEntityTag,
  ifNoneMatchMatches,
  ifRangeAllowsPartial,
  parseSingleByteRange,
  privateRevalidationHeaders,
} from "@/lib/http-file-response";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const user = await getSessionUser();
  if (!user) return fail("未登录或登录已过期", 401);

  const { id } = await ctx.params;
  const row = db
    .prepare("SELECT * FROM videos WHERE id = ?")
    .get(id) as unknown as VideoRow | undefined;
  if (!row) return fail("视频不存在", 404);
  if (!canManageVideo(user, row.uploaded_by)) return fail("视频不存在", 404);

  const filePath = getVideoPath(row.stored_name);
  if (!fs.existsSync(filePath)) return fail("视频文件已丢失", 404);

  const stat = fs.statSync(filePath);
  // 内容类型只按服务端识别的扩展名推导，绝不信任客户端上传时填写的 MIME
  const contentType = mimeForExt(path.extname(row.stored_name).toLowerCase());
  const etag = fileEntityTag(stat);
  const revalidationHeaders = privateRevalidationHeaders(stat, etag);

  if (ifNoneMatchMatches(req.headers.get("if-none-match"), etag)) {
    return new Response(null, {
      status: 304,
      headers: revalidationHeaders,
    });
  }

  const requestedRange = req.headers.get("range");
  const range =
    requestedRange &&
    ifRangeAllowsPartial(req.headers.get("if-range"), etag, stat.mtimeMs)
      ? parseSingleByteRange(requestedRange, stat.size)
      : undefined;

  if (requestedRange && range === null) {
    return new Response(null, {
      status: 416,
      headers: {
        ...revalidationHeaders,
        "Content-Range": `bytes */${stat.size}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  if (range) {
    const stream = Readable.toWeb(
      fs.createReadStream(filePath, { start: range.start, end: range.end }),
    ) as unknown as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        ...revalidationHeaders,
        "Content-Type": contentType,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
        "Accept-Ranges": "bytes",
      },
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
      "Accept-Ranges": "bytes",
    },
  });
}

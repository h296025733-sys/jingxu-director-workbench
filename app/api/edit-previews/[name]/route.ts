import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { withAuth, fail } from "@/lib/api";
import { DATA_DIR } from "@/lib/paths";
import { CLONE_PREVIEW_VERSION, isClonePreviewName, isColorPreviewName, isVoiceAuditionName } from "@/lib/clone-preview-files";
import { fileEntityTag, privateRevalidationHeaders, ifNoneMatchMatches, ifRangeAllowsPartial, parseSingleByteRange } from "@/lib/http-file-response";

type Ctx = { params: Promise<{ name: string }> };

export const GET = withAuth<Ctx>(async (req, ctx) => {
  const { name } = await ctx.params;
  const colorPreview = isColorPreviewName(name);
  const voiceAudition = isVoiceAuditionName(name);
  if (!colorPreview && !voiceAudition && !isClonePreviewName(name)) return fail("试听不存在", 404);
  const requested = new URL(req.url).searchParams.get("v");
  const version = requested === "3" ? 3 : requested === "2" ? 2 : CLONE_PREVIEW_VERSION;
  const file = colorPreview
    ? path.join(DATA_DIR,"edit-color-previews","v1",name)
    : voiceAudition
      ? path.join(DATA_DIR, "voice-templates", "v1", "profile-auditions", name)
      : path.join(DATA_DIR, "voice-templates", `v${version}`, "previews", name);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return fail("试听正在准备，稍后再试", 404);
  const etag = fileEntityTag(stat);
  const headers = { ...privateRevalidationHeaders(stat, etag), "Content-Type": voiceAudition ? "audio/wav" : "video/mp4", "Accept-Ranges": "bytes" };
  if (ifNoneMatchMatches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  const requestRange = req.headers.get("range");
  const range = requestRange && ifRangeAllowsPartial(req.headers.get("if-range"), etag, stat.mtimeMs)
    ? parseSingleByteRange(requestRange, stat.size) : undefined;
  if (range === null) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
  const stream = createReadStream(file, range ?? undefined);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: range ? 206 : 200,
    headers: { ...headers, "Content-Length": String(range ? range.end - range.start + 1 : stat.size), ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}` } : {}) },
  });
});

import { fail, ok, withAuth } from "@/lib/api";
import {
  cancelVideoUploadSession,
  cleanupStaleVideoUploadSessions,
  findVideoUploadSession,
} from "@/lib/video-upload-sessions";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = withAuth<Ctx>(async (_req, ctx, user) => {
  const { id } = await ctx.params;
  cleanupStaleVideoUploadSessions();
  const session = findVideoUploadSession(id);
  if (!session) return ok({ message: "已取消上传" });
  if (session.uploaded_by !== user.username) {
    return fail("上传任务不存在", 404);
  }
  if (session.status === "assembling") {
    return fail("上传任务正在收尾，请稍后再试", 409);
  }

  if (!cancelVideoUploadSession(id)) return fail("视频正在保存，请稍候", 409);
  return ok({ message: "已取消上传" });
});

import { fail, ok, withAuth, type NoParams } from "@/lib/api";
import { AIClient, getSettings } from "@/lib/ai";

export const POST = withAuth<NoParams>(async (_req, _ctx, user) => {
  if (!user.isAdmin) return fail("仅管理员可测试连接", 403);
  const settings = getSettings();
  try {
    const reply = await new AIClient(settings).testConnection();
    return ok({
      ok: true,
      reply,
      message: `连接成功（模型：${settings.model}）`,
    });
  } catch (err) {
    return fail(err instanceof Error ? err.message : "连接失败", 400);
  }
});

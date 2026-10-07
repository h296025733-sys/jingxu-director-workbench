import { db } from "@/lib/db";
import { fail, ok, readJson, withAuth } from "@/lib/api";
import { ownedVoice } from "@/lib/personal-voices";
type Ctx = { params: Promise<{ id: string }> };

export const PATCH = withAuth<Ctx>(async (req, ctx, user) => {
  const { id } = await ctx.params;
  if (!ownedVoice(id, user.username)) return fail("音色不存在", 404);
  const body = await readJson(req, 2048);
  if (body.archive === true) {
    // Archive only hides the library entry. Existing queued edits and audio
    // downloads retain their immutable reference and continue working.
    db.prepare("UPDATE personal_voices SET archived=1 WHERE id=? AND created_by=?").run(id, user.username);
  } else {
    const name = String(body.name ?? "").trim();
    if (!name || name.length > 40) return fail("请输入40字以内的音色名字");
    db.prepare("UPDATE personal_voices SET name=? WHERE id=? AND created_by=?").run(name, id, user.username);
  }
  return ok({ success: true });
});

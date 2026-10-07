import { db } from "@/lib/db";
import { fail, ok, readJson, withAuth } from "@/lib/api";
import { ownedVoice } from "@/lib/personal-voices";
import { MAX_PENDING_WORK_GLOBAL } from "@/lib/concurrency-config";
import { scheduleTask } from "@/lib/tasks";
type Ctx = { params: Promise<{ id: string }> };

export const POST = withAuth<Ctx>(async (req, ctx, user) => {
  const { id } = await ctx.params;
  const body = await readJson(req, 8192);
  const text = String(body.text ?? "").trim();
  const language = String(body.language ?? "en");
  const emotion = String(body.emotion ?? "neutral");
  if (!text || text.length > 500) return fail("请输入1至500字符的台词，长文请分成连贯段落分别生成");
  if (!/[a-záéíóúüñ]/i.test(text) || /[\u3400-\u9fff]/u.test(text)) return fail("目前支持英语和西班牙语配音，请直接填写对应语言的台词（不会自动翻译或改写）");
  if (!['en', 'es'].includes(language) || !['neutral', 'excited', 'emphatic'].includes(emotion)) return fail("语言或语气选项无效");
  let taskId: number;
  db.exec("BEGIN IMMEDIATE");
  try {
    const voice = ownedVoice(id, user.username);
    if (!voice) { db.exec("ROLLBACK"); return fail("音色不存在", 404); }
    const params = JSON.stringify({ personalVoiceId: id, text, language, emotion });
    const duplicate = db.prepare("SELECT id FROM tasks WHERE feature_id='voice_clone' AND created_by=? AND params_json=? AND status IN ('pending','running')").get(user.username, params) as { id: number } | undefined;
    if (duplicate) { db.exec("COMMIT"); return ok({ taskId: duplicate.id }); }
    const count = (owner?: string) => Number((db.prepare(`SELECT
      (SELECT COUNT(*) FROM tasks WHERE status IN ('pending','running') ${owner ? 'AND created_by=?' : ''}) +
      (SELECT COUNT(*) FROM task_delivery_packages WHERE status IN ('pending','running') ${owner ? 'AND created_by=?' : ''}) +
      (SELECT COUNT(*) FROM task_prompt_translations WHERE status IN ('pending','running') ${owner ? 'AND created_by=?' : ''}) AS n`)
      .get(...(owner ? [owner, owner, owner] : [])) as { n: number }).n);
    if (count(user.username) >= 2 || count() >= MAX_PENDING_WORK_GLOBAL) { db.exec("ROLLBACK"); return fail("任务队列暂满，请等待当前任务完成后再生成；音色和台词无需重新上传", 429); }
    taskId = Number(db.prepare(`INSERT INTO tasks(video_id,video_name,secondary_video_id,secondary_video_name,feature_id,params_json,status,created_by,created_at)
      VALUES('',?,'','','voice_clone',?,'pending',?,?)`).run(voice.name, params, user.username, new Date().toISOString()).lastInsertRowid);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  scheduleTask(taskId);
  return ok({ taskId });
});

import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { fail, ok, readJson, withAuth, type NoParams } from "@/lib/api";
import { personalVoiceOut, type PersonalVoiceRow } from "@/lib/personal-voices";

export const GET = withAuth<NoParams>(async (req, _ctx, user) => {
  const rows = db.prepare("SELECT * FROM personal_voices WHERE created_by=? AND archived=0 ORDER BY created_at DESC").all(user.username) as unknown as PersonalVoiceRow[];
  if (req.nextUrl.searchParams.get("libraryOnly") === "1") return ok({ voices: rows.map(personalVoiceOut) });
  const tasks = db.prepare(`SELECT id, params_json, status, progress, message, error, created_at
    FROM tasks WHERE feature_id='voice_clone' AND created_by=? ORDER BY id DESC LIMIT 30`).all(user.username);
  return ok({ voices: rows.map(personalVoiceOut), tasks: tasks.map((row) => {
    const params = JSON.parse(String(row.params_json));
    return { id: row.id, voiceId: params.personalVoiceId, text: params.text, language: params.language, emotion: params.emotion,
      status: row.status, progress: row.progress, message: row.message, error: row.error, createdAt: row.created_at,
      audioUrl: row.status === "succeeded" ? `/api/tasks/${row.id}/artifacts/voice/final.wav` : null };
  }) });
});

export const POST = withAuth<NoParams>(async (req, _ctx, user) => {
  const body = await readJson(req, 8192);
  const name = String(body.name ?? "").trim();
  const sources = Array.isArray(body.sourceIds) ? body.sourceIds : [];
  if (!name || name.length > 40) return fail("请为音色填写40字以内的名字");
  if (body.authorized !== true) return fail("请确认音源属于你或已获得使用授权");
  if (sources.length < 1 || sources.length > 2 || sources.some(x => typeof x !== "string") || new Set(sources).size !== sources.length) return fail("请选择1至2个不同的音频或视频参考文件");
  db.exec("BEGIN IMMEDIATE");
  try {
    const count = db.prepare("SELECT COUNT(*) AS n FROM personal_voices WHERE created_by=? AND archived=0").get(user.username) as { n: number };
    if (count.n >= 30) { db.exec("ROLLBACK"); return fail("最多保存30个个人音色，请先归档不再使用的音色", 409); }
    for (const id of sources) {
      const file = db.prepare("SELECT mime_type FROM videos WHERE id=? AND uploaded_by=?").get(id, user.username) as { mime_type: string } | undefined;
      if (!file || !/^(audio|video)\//.test(file.mime_type)) { db.exec("ROLLBACK"); return fail("只能选择自己上传的音频或视频", 400); }
    }
    const id = randomUUID();
    db.prepare("INSERT INTO personal_voices(id,created_by,name,source_ids_json,created_at) VALUES(?,?,?,?,?)").run(id, user.username, name, JSON.stringify(sources), new Date().toISOString());
    db.exec("COMMIT");
    return ok({ id });
  } catch (error) { db.exec("ROLLBACK"); throw error; }
});

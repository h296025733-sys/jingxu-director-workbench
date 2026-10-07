import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FeatureContext, FeatureDefinition } from "./base";
import { db } from "@/lib/db";
import { DATA_DIR, PROJECT_ROOT } from "@/lib/paths";
import { getVideoPath } from "@/lib/storage";
import { ownedVoice, verifiedPersonalReference, voiceReferenceDirectory } from "@/lib/personal-voices";
import { runBoundedProcess } from "@/lib/auto-edit";
import { withVoiceSlot } from "@/lib/voice-capacity";
import type { VideoRow } from "@/lib/types";

const LAB = "D:/workspace/codex-auto-video-lab";

async function runVoiceClone(context: FeatureContext) {
  const owner = context.createdBy ?? "";
  const id = String(context.params.personalVoiceId ?? "");
  const voice = ownedVoice(id, owner, true);
  if (!voice) throw new Error("个人音色不存在或不属于当前账号");
  const text = String(context.params.text ?? "").trim();
  const language = String(context.params.language);
  const emotion = String(context.params.emotion);
  if (!text || text.length > 500 || !["en", "es"].includes(language) || !["neutral", "excited", "emphatic"].includes(emotion)) throw new Error("请填写500字符以内的英文或西班牙语台词，并选择有效语言和语气");
  const root = path.join(context.outputDir, "voice");
  fs.mkdirSync(root, { recursive: true });
  const run = (script: string, args: string[], stage: string, gpu = false) => runBoundedProcess({
    executable: path.join(LAB, gpu ? "venvs/cosyvoice3-py310/python.exe" : ".venv/Scripts/python.exe"),
    args: [path.join(PROJECT_ROOT, "scripts", script), ...args], cwd: LAB, stage,
    timeoutMs: 10 * 60_000, signal: context.signal,
  });
  if (voice.status !== "ready") {
    const ids = JSON.parse(voice.source_ids_json) as string[];
    if (ids.length < 1 || ids.length > 2) throw new Error("音色需要1至2个参考文件");
    const candidates: { directory: string; score: number; sourceId: string }[] = [];
    const issues: string[] = [];
    for (const [index, sourceId] of ids.entries()) {
      context.signal.throwIfAborted();
      context.updateProgress(10 + index * 15, `正在检查第${index + 1}个音源，挑选连续清晰人声`);
      const source = db.prepare("SELECT * FROM videos WHERE id=? AND uploaded_by=?").get(sourceId, owner) as unknown as VideoRow | undefined;
      if (!source) throw new Error("参考文件已不可用，请重新创建音色");
      const directory = path.join(root, `source-${index + 1}`);
      try {
        await run("prepare-edit-voice-reference.py", ["--source", getVideoPath(source.stored_name), "--output-dir", directory], "克隆音源提取");
        const report = JSON.parse(fs.readFileSync(path.join(directory, "reference-report.json"), "utf8"));
        candidates.push({ directory, sourceId, score: Number(report.selectionScore) || 0 });
      } catch (error) {
        context.signal.throwIfAborted();
        issues.push(`音源${index + 1}：${error instanceof Error ? error.message : "未找到清晰人声"}`);
      }
    }
    fs.writeFileSync(path.join(root, "selection.json"), JSON.stringify({ candidates, issues }, null, 2));
    const selected = candidates.sort((a, b) => b.score - a.score)[0];
    if (!selected) throw new Error(issues.join("；"));
    const destination = voiceReferenceDirectory(id);
    fs.mkdirSync(destination, { recursive: true });
    for (const name of ["reference.wav", "reference-report.json"]) fs.copyFileSync(path.join(selected.directory, name), path.join(destination, name));
    db.prepare("UPDATE personal_voices SET status='ready' WHERE id=? AND created_by=?").run(id, owner);
  }
  context.signal.throwIfAborted();
  const reference = verifiedPersonalReference(id, owner, true);
  const localReference = path.join(root, "reference");
  fs.mkdirSync(localReference, { recursive: true });
  for (const name of ["reference.wav", "reference-report.json"]) fs.copyFileSync(path.join(reference, name), path.join(localReference, name));
  // A generous budget is only a synthesis ceiling. The delivered file is the
  // actual continuous take, never a 90-second stem with manufactured silence.
  const request = path.join(root, "request.json");
  fs.writeFileSync(request, JSON.stringify({ purpose: "standalone_voice", voice: "male", emotion, language,
    duration: 90, delivery: "continuous", lines: [{ start: 0, end: 90, text }] }));
  context.updateProgress(40, "音色已保存，正在等待配音；准备好后自动继续");
  await withVoiceSlot(context.signal, async () => {
    context.updateProgress(50, "正在按完整台词连续配音");
    await run("synthesize-edit-narration.py", ["--request", request, "--voices", path.join(DATA_DIR, "voice-templates/v1"), "--reference", path.join(localReference, "reference.wav")], "个人音色配音", true);
    context.updateProgress(75, "正在回听识别台词，检查漏读和错读");
    // This verifier may perform one bounded same-source re-synthesis, so it
    // remains inside the global voice permit as in the auto-edit pipeline.
    await run("verify-edit-narration.py", ["--request", request], "个人配音台词核对");
  });
  context.signal.throwIfAborted();
  const ready = JSON.parse(fs.readFileSync(path.join(root, "narration-ready.json"), "utf8"));
  const line = ready.lines?.[0];
  if (ready.lines?.length !== 1 || line.text !== text || line.skipped) throw new Error("音色已保存，但这次配音仍有漏读或错读，未作为成品交付。台词已保留，可重新生成；品牌和特殊读法可在台词中写成发音形式。");
  const file = path.resolve(String(line.file));
  if (path.dirname(file) !== path.join(root, "narration") || createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== line.sha256) throw new Error("配音文件校验未通过，原音色已保留");
  fs.copyFileSync(file, path.join(root, "final.wav"));
  const url = `/api/tasks/${context.taskId}/artifacts/voice/final.wav`;
  return { message: "配音已生成并核对台词。请试听确认音色、语速和情绪。", media: [{ type: "audio" as const, url, title: voice.name }],
    extra: { voiceClone: { personalVoiceId: id, name: voice.name, text, language, emotion, seconds: line.seconds, audioUrl: url, textVerified: true, listeningAccepted: false } } };
}

export const voiceCloneFeature: FeatureDefinition = {
  id: "voice_clone", name: "声音克隆", description: "保存个人音色，输入台词生成可下载配音。", icon: "♫", status: "ready",
  inputSchema: { type: "object", properties: {} }, run: runVoiceClone,
};

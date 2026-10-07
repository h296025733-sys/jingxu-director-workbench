import fs from "node:fs";
import path from "node:path";
import { fail, ok, withAuth, type NoParams } from "@/lib/api";
import { getSettings } from "@/lib/ai";
import { DATA_DIR } from "@/lib/paths";
import { codexCapacitySnapshot } from "@/lib/codex-capacity";
import { workSchedulerSnapshot } from "@/lib/work-scheduler";
import { localMediaCapacitySnapshot } from "@/lib/local-media-capacity";

function exists(value: string): boolean {
  try {
    return fs.existsSync(value);
  } catch {
    return false;
  }
}

export const GET = withAuth<NoParams>(async (_req, _ctx, user) => {
  if (!user.isAdmin) return fail("仅管理员可查看运行状态", 403);
  const settings = getSettings();
  const workbench = path.resolve(settings.directorWorkbenchPath);
  const vendorRoot = path.join(workbench, "tools", "vendor");
  let hasFfmpeg = false;
  try {
    hasFfmpeg = fs
      .readdirSync(vendorRoot, { withFileTypes: true })
      .some(
        (entry) =>
          entry.isDirectory() &&
          entry.name.startsWith("ffmpeg-") &&
          exists(path.join(vendorRoot, entry.name, "bin", "ffmpeg.exe")),
      );
  } catch {
    hasFfmpeg = false;
  }
  const checks = [
    { label: "导演引擎", ready: exists(path.join(DATA_DIR, "codex-home", "auth.json")) },
    {
      label: "视频理解",
      ready:
        exists(path.join(workbench, ".venv", "Scripts", "python.exe")) &&
        hasFfmpeg,
    },
    {
      label: "参考图生成",
      ready: exists(path.join(process.cwd(), ".agents", "skills", "imagegen", "SKILL.md")),
    },
    {
      label: "动作参考处理",
      ready:
        exists(path.join(workbench, ".venv-pose", "Scripts", "python.exe")) &&
        exists(path.join(workbench, "tools", "anonymize_face_reference.py")),
    },
    { label: "D 盘素材存储", ready: path.parse(path.resolve(DATA_DIR)).root.toUpperCase() === "D:\\" },
  ];
  const scheduler = workSchedulerSnapshot();
  return ok({ checks, ready: checks.every((check) => check.ready), capacity: {
    codex: codexCapacitySnapshot(), localMedia: localMediaCapacitySnapshot(), jobs: { limit: scheduler.totalConcurrency, active: scheduler.active.length, waiting: scheduler.queued.length, editingLimit: scheduler.editingConcurrency, voiceLimit: scheduler.voiceConcurrency },
  } });
});

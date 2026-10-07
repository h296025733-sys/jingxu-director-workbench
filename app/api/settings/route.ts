import fs from "node:fs";
import path from "node:path";
import { fail, ok, readJson, withAuth, type NoParams } from "@/lib/api";
import {
  getSettings,
  isReasoningEffort,
  maskApiKey,
  saveSettings,
} from "@/lib/ai";
import { DATA_DIR, PROJECT_ROOT, UPLOAD_DIR } from "@/lib/paths";
import { logAudit } from "@/lib/audit";

export const GET = withAuth<NoParams>(async (_req, _ctx, user) => {
  if (!user.isAdmin) return fail("仅管理员可查看设置", 403);
  const settings = getSettings();
  return ok({
    settings: { ...settings, apiKey: maskApiKey(settings.apiKey) },
    server: {
      appName: "镜序",
      version: "0.2.0",
      node: process.version,
      dataDir: DATA_DIR,
      uploadDir: UPLOAD_DIR,
    },
  });
});

export const PUT = withAuth<NoParams>(async (req, _ctx, user) => {
  if (!user.isAdmin) return fail("仅管理员可修改设置", 403);
  const body = await readJson(req);
  const current = getSettings();

  const provider = String(body.provider ?? current.provider);
  if (!["codex_subscription", "openai", "custom"].includes(provider)) {
    return fail("不支持的 AI 接入方式");
  }
  const model = String(body.model ?? current.model).trim();
  if (!model) return fail("模型名称不能为空");
  const effort = body.reasoningEffort ?? current.reasoningEffort;
  if (!isReasoningEffort(effort)) return fail("推理强度无效");

  const workbenchPath = path.resolve(
    String(body.directorWorkbenchPath ?? current.directorWorkbenchPath).trim(),
  );
  if (provider === "codex_subscription") {
    const requiredPaths = [
      workbenchPath,
      path.join(workbenchPath, "AGENTS.md"),
      path.join(workbenchPath, ".agents", "skills", "viral-product-director", "SKILL.md"),
      path.join(workbenchPath, ".agents", "skills", "replicate-viral-video", "SKILL.md"),
      path.join(PROJECT_ROOT, ".agents", "skills", "imagegen", "SKILL.md"),
    ];
    if (requiredPaths.some((candidate) => !fs.existsSync(candidate))) {
      return fail("导演长期工作台路径无效，或缺少指定导演 / imagegen 技能");
    }
  }

  const timeoutValue = Number(body.timeoutSeconds ?? current.timeoutSeconds);
  if (!Number.isFinite(timeoutValue)) return fail("超时时间必须是有效数字");

  const baseUrl = String(body.baseUrl ?? current.baseUrl).trim();
  if (provider !== "codex_subscription") {
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
    } catch {
      return fail("Base URL 必须是有效的 HTTP(S) 地址");
    }
  }

  // 前端传回掩码（含 ****）时视为未修改，保留原 Key
  let apiKey = typeof body.apiKey === "string" ? body.apiKey : current.apiKey;
  if (apiKey.trim() === "" || apiKey.includes("****")) apiKey = current.apiKey;

  const next = saveSettings({
    provider,
    baseUrl,
    model,
    reasoningEffort: effort,
    timeoutSeconds: Math.max(30, Math.min(3600, Math.round(timeoutValue))),
    directorWorkbenchPath: workbenchPath,
    apiKey: apiKey.trim(),
  });
  logAudit(user.username, "settings_update", "AI 配置被修改");
  return ok({
    settings: { ...next, apiKey: maskApiKey(next.apiKey) },
    message: "设置已保存",
  });
});

import "server-only";

import path from "node:path";
import { db } from "./db";
import { PROJECT_ROOT } from "./paths";
import {
  runAutoVideoEditingReview,
  runAutoVideoEditingPlan,
  runEditingNarrationRepair,
  runEditingNarrationFlow,
  type EditingNarrationRepairLine,
  runDirectorSkill,
  testCodexConnection,
  type AutoVideoEditReview,
  type AutoVideoEditReviewQualityIssue,
  type AutoVideoEditPlan,
  type CodexDirectorOutput,
  type DirectorInputAsset,
  type DirectorSkillName,
  type EditingPlanParameters,
} from "./codex-director";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AISettings {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  timeoutSeconds: number;
  directorWorkbenchPath: string;
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  provider: "codex_subscription",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
  timeoutSeconds: 900,
  directorWorkbenchPath: path.resolve(
    PROJECT_ROOT,
    "..",
    "..",
    "Seedance视频导演工作台",
  ),
};

function reasoningEffort(value: string | undefined): ReasoningEffort {
  return ["minimal", "low", "medium", "high", "xhigh"].includes(value ?? "")
    ? (value as ReasoningEffort)
    : DEFAULT_AI_SETTINGS.reasoningEffort;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === "string" &&
    ["minimal", "low", "medium", "high", "xhigh"].includes(value)
  );
}

export function getSettings(): AISettings {
  const rows = db
    .prepare("SELECT key, value FROM settings")
    .all() as unknown as { key: string; value: string }[];
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const storedTimeout = Number(map.timeout_seconds);
  return {
    provider: map.provider ?? DEFAULT_AI_SETTINGS.provider,
    baseUrl: map.base_url ?? DEFAULT_AI_SETTINGS.baseUrl,
    apiKey: map.api_key ?? "",
    model: map.model ?? DEFAULT_AI_SETTINGS.model,
    reasoningEffort: reasoningEffort(map.reasoning_effort),
    timeoutSeconds: Number.isFinite(storedTimeout)
      ? Math.max(30, Math.min(3600, storedTimeout))
      : DEFAULT_AI_SETTINGS.timeoutSeconds,
    directorWorkbenchPath:
      map.director_workbench_path ?? DEFAULT_AI_SETTINGS.directorWorkbenchPath,
  };
}

export function saveSettings(
  partial: Partial<Omit<AISettings, "apiKey">> & { apiKey?: string },
): AISettings {
  const current = getSettings();
  const merged: AISettings = {
    provider: partial.provider ?? current.provider,
    baseUrl: partial.baseUrl ?? current.baseUrl,
    apiKey: partial.apiKey ?? current.apiKey,
    model: partial.model ?? current.model,
    reasoningEffort: partial.reasoningEffort ?? current.reasoningEffort,
    timeoutSeconds: partial.timeoutSeconds ?? current.timeoutSeconds,
    directorWorkbenchPath:
      partial.directorWorkbenchPath ?? current.directorWorkbenchPath,
  };
  const setStmt = db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  setStmt.run("provider", merged.provider);
  setStmt.run("base_url", merged.baseUrl);
  setStmt.run("api_key", merged.apiKey);
  setStmt.run("model", merged.model);
  setStmt.run("reasoning_effort", merged.reasoningEffort);
  setStmt.run("timeout_seconds", String(merged.timeoutSeconds));
  setStmt.run("director_workbench_path", merged.directorWorkbenchPath);
  return merged;
}

export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "";
  if (apiKey.length <= 8) return "****";
  return `${apiKey.slice(0, 4)}****${apiKey.slice(-4)}`;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * 统一 AI 客户端：保留 OpenAI 兼容文本接口，并提供受限的 Codex Skills
 * 导演入口。视频不会伪装成模型原生输入，而是先生成本地证据包。
 */
export class AIClient {
  constructor(private readonly settings: AISettings) {}

  get configuration(): Readonly<AISettings> {
    return this.settings;
  }

  private endpoint(path: string): string {
    return `${this.settings.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  async chat(messages: ChatMessage[], maxTokens = 2048): Promise<string> {
    if (!this.settings.apiKey) {
      throw new Error("尚未配置 API Key，请先到「AI 设置」页面填写");
    }
    const res = await fetch(this.endpoint("/chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.settings.apiKey}`,
      },
      body: JSON.stringify({
        model: this.settings.model,
        messages,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(this.settings.timeoutSeconds * 1000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`AI 接口返回 ${res.status}：${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("AI 接口返回内容为空");
    return content;
  }

  async testConnection(): Promise<string> {
    if (this.settings.provider === "codex_subscription") {
      return testCodexConnection(this.settings);
    }
    return this.chat(
      [{ role: "user", content: "请只回复四个字：连接成功" }],
      16,
    );
  }

  async repairEditingNarration(options:{lines:EditingNarrationRepairLine[];language:"en"|"es";referenceBrief?:string;requireBriefCoverage?:boolean;signal?:AbortSignal}):Promise<{index:number;text:string}[]>{
    return runEditingNarrationRepair({...options,settings:this.settings});
  }

  async composeEditingNarrationFlow(options:{
    lines:{start:number;end:number;text:string;evidence:string}[];
    brief:string;language:"en"|"es";maxWords:number;requireBriefCoverage?:boolean;signal?:AbortSignal;
  }):Promise<string>{
    return runEditingNarrationFlow({...options,settings:this.settings});
  }

  /** 原生视频输入不受当前 Codex CLI / gpt-5.6-sol 支持。 */
  async chatWithVideo(
    _messages: ChatMessage[],
    _videoPath: string,
  ): Promise<string> {
    throw new Error(
      "Codex CLI 不接受原生视频输入；请通过导演技能入口先生成本地视频证据包",
    );
  }

  async runDirector(options: {
    skillName: DirectorSkillName;
    taskId: number;
    videoName: string;
    videoPath: string;
    evidenceDirectory: string;
    contactSheetPath?: string | null;
    params: Record<string, unknown>;
    assets: DirectorInputAsset[];
    reasoningEffort?: ReasoningEffort;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  }): Promise<{ output: CodexDirectorOutput; threadId: string | null }> {
    if (this.settings.provider !== "codex_subscription") {
      throw new Error(
        "这两个导演功能依赖 Codex Skills，请在「AI 设置」选择“Codex 本机订阅”",
      );
    }
    return runDirectorSkill({
      ...options,
      settings: {
        ...this.settings,
        reasoningEffort: options.reasoningEffort ?? this.settings.reasoningEffort,
      },
    });
  }

  /**
   * Produce one Auto Video Lab edit plan. The caller remains responsible for
   * persisting it and running AutoLab's native `validate` before rendering.
   */
  async runEditingPlan(options: {
    taskId: number;
    labRoot: string;
    jobRoot: string;
    brief: string;
    analysisPath: string;
    draftPlanPath: string;
    visualEvidencePaths?: string[];
    params?: Partial<EditingPlanParameters> | Record<string, unknown>;
    reasoningEffort?: ReasoningEffort;
    signal?: AbortSignal;
  }): Promise<{ plan: AutoVideoEditPlan; threadId: string | null; qualityNote?: string }> {
    if (this.settings.provider !== "codex_subscription") {
      throw new Error("自动剪辑规划依赖 Codex Skills，请使用 Codex 本机订阅模式");
    }
    return runAutoVideoEditingPlan({
      ...options,
      settings: {
        ...this.settings,
        reasoningEffort: options.reasoningEffort ?? this.settings.reasoningEffort,
      },
    });
  }

  /**
   * Inspect server-created post-render stills and return one verdict plus an
   * optional bounded replacement plan. Rendering remains the caller's job.
   */
  async runEditingReview(options: {
    taskId: number;
    labRoot: string;
    jobRoot: string;
    brief: string;
    analysisPath: string;
    planPath: string;
    qaPath: string;
    reviewVisualEvidencePaths: string[];
    qualityIssues?: readonly AutoVideoEditReviewQualityIssue[];
    params?: Partial<EditingPlanParameters> | Record<string, unknown>;
    reasoningEffort?: ReasoningEffort;
    signal?: AbortSignal;
  }): Promise<{ review: AutoVideoEditReview; threadId: string | null }> {
    if (this.settings.provider !== "codex_subscription") {
      throw new Error("自动剪辑成片复检依赖 Codex Skills，请使用 Codex 本机订阅模式");
    }
    return runAutoVideoEditingReview({
      ...options,
      settings: {
        ...this.settings,
        reasoningEffort: options.reasoningEffort ?? this.settings.reasoningEffort,
      },
    });
  }
}

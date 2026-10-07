"use client";
import { getEditTemplate } from "@/lib/edit-templates";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Loader2,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import LiveProgress from "@/components/LiveProgress";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { taskStatusMeta } from "@/lib/format";
import { apiSend } from "@/lib/client";
import { selectFinalSeedancePrompt } from "@/lib/seedance-prompt-display";
import type { ReferenceDeliveryMode, TaskOut } from "@/lib/types";
import TaskGeneratedImages, {
  type ProvidedTaskAsset,
} from "@/components/TaskGeneratedImages";
import { toast } from "sonner";

interface DirectorExecutionCard {
  aspectRatio: string;
  resolution: string;
  duration: string;
  audio: string;
}

interface DirectorPrompt {
  title: string;
  purpose: string;
  content: string;
}

interface DirectorUploadItem {
  order: number;
  reference: string;
  assetKey: string;
  displayName: string;
  type: string;
  coreResponsibility: string;
  doNotReference: string;
  timeRange: string;
}

interface DirectorRequiredAsset {
  kind: string;
  status: "provided" | "missing" | "not_applicable" | "unknown";
  assetKey: string;
  reason: string;
  generationPrompt: string;
  canGenerate: boolean;
  dependsOnAssetKeys: string[];
}

interface DirectorResult {
  status: string;
  routing: {
    mode: string;
    rationale: string;
  } | null;
  executionCard: DirectorExecutionCard;
  prompts: DirectorPrompt[];
  uploadPlan: DirectorUploadItem[];
  requiredAssets: DirectorRequiredAsset[];
  understanding: {
    title: string;
    viralCore: string[];
    adaptation: string;
  } | null;
}

const DELIVERY_OPTIONS: Array<{
  value: ReferenceDeliveryMode;
  label: string;
}> = [
  { value: "text_only", label: "只要提示词" },
  { value: "images_text", label: "图片 + 提示词" },
  { value: "video_images_text", label: "视频 + 图片 + 提示词" },
];

function normalizeReferenceDelivery(value: unknown): ReferenceDeliveryMode {
  if (value === "text_only") return "text_only";
  if (value === "video_images_text" || value === "allow_video") {
    return "video_images_text";
  }
  return "images_text";
}

function referenceDeliveryModes(value: unknown): ReferenceDeliveryMode[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is ReferenceDeliveryMode =>
      item === "text_only" ||
      item === "images_text" ||
      item === "video_images_text",
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function autoEditLanguageLabel(value: unknown): string {
  return value === "es" ? "Español 字幕" : "English 字幕";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function legacyCanGenerate(kind: string, generationPrompt: string): boolean {
  if (!generationPrompt) return false;
  if (
    /(?:product|packag|logo|brand|certificate|evidence|document|reference_video|audio|产品|包装|商标|品牌|证书|证明|证据|文件|视频|音频)/i.test(
      kind,
    )
  ) {
    return false;
  }
  if (
    /(?:background|scene|environment|style|storyboard|pose|action|wardrobe|背景|场景|环境|画风|风格|分镜|姿势|动作|服装)/i.test(
      kind,
    )
  ) {
    return true;
  }
  return (
    /(?:character|person|identity|人物|角色|身份)/i.test(kind) &&
    /(?:虚构|原创|不对应任何现实|非现实人物|fictional|original character|not (?:a )?real person)/i.test(
      generationPrompt,
    )
  );
}

function normalizeDirector(value: unknown): DirectorResult | null {
  const director = asRecord(value);
  if (!director) return null;
  const execution = asRecord(director.executionCard) ?? {};
  const prompts = Array.isArray(director.prompts)
    ? director.prompts.flatMap((value): DirectorPrompt[] => {
        const prompt = asRecord(value);
        if (!prompt) return [];
        return [
          {
            title: asString(prompt.title),
            purpose: asString(prompt.purpose),
            content: asString(prompt.content),
          },
        ];
      })
    : [];
  const uploadPlan = Array.isArray(director.uploadPlan)
    ? director.uploadPlan.flatMap((value): DirectorUploadItem[] => {
        const item = asRecord(value);
        if (!item) return [];
        return [
          {
            order: typeof item.order === "number" ? item.order : 0,
            reference: asString(item.reference),
            assetKey: asString(item.assetKey),
            displayName: asString(item.displayName),
            type: asString(item.type),
            coreResponsibility: asString(item.coreResponsibility),
            doNotReference: asString(item.doNotReference),
            timeRange: asString(item.timeRange),
          },
        ];
      })
    : [];
  const requiredAssets = Array.isArray(director.requiredAssets)
    ? director.requiredAssets.flatMap((value): DirectorRequiredAsset[] => {
        const asset = asRecord(value);
        if (!asset) return [];
        const status = asString(asset.status);
        const kind = asString(asset.kind);
        const generationPrompt = asString(asset.generationPrompt);
        return [
          {
            kind,
            status:
              status === "provided" ||
              status === "missing" ||
              status === "not_applicable"
                ? status
                : "unknown",
            assetKey: asString(asset.assetKey),
            reason: asString(asset.reason),
            generationPrompt,
            canGenerate:
              typeof asset.canGenerate === "boolean"
                ? asset.canGenerate
                : legacyCanGenerate(kind, generationPrompt),
            dependsOnAssetKeys: asStringArray(asset.dependsOnAssetKeys),
          },
        ];
      })
    : [];

  return {
    status: asString(director.status),
    routing: (() => {
      const raw = asRecord(director.routing);
      if (!raw) return null;
      const mode = asString(raw.mode);
      const rationale = asString(raw.rationale);
      return mode ? { mode, rationale } : null;
    })(),
    executionCard: {
      aspectRatio: asString(execution.aspectRatio),
      resolution: asString(execution.resolution),
      duration: asString(execution.duration),
      audio: asString(execution.audio),
    },
    prompts,
    uploadPlan,
    requiredAssets,
    understanding: (() => {
      const raw = asRecord(director.understanding);
      if (!raw) return null;
      const title = asString(raw.title);
      const viralCore = asStringArray(raw.viralCore);
      const adaptation = asString(raw.adaptation);
      return title && viralCore.length > 0 && adaptation
        ? { title, viralCore, adaptation }
        : null;
    })(),
  };
}

function routeLabel(mode: string): string {
  return (
    {
      ORIGINAL: "从零创作",
      VIRAL_ADAPTATION: "拆爆点，写新故事",
      CONTENT_IMITATION: "换内容，保留故事",
      STRICT_REPLICATION: "严格复刻",
      REPAIR: "修复跑偏",
    }[mode] ?? "自动判断"
  );
}

function autoEditProgressText(
  progress: number,
  status: string,
  transcribe: boolean,
): string {
  if (status === "pending") return "等待开始";
  if (status !== "running") return "";
  if (progress < 20) return "正在读素材";
  if (progress < 40) return transcribe ? "正在听内容" : "正在看画面";
  if (progress < 70) return "正在编排剪辑";
  if (progress < 90) return "正在渲染成片";
  return "正在检查成片";
}

function settingValue(
  params: Record<string, unknown>,
  director: DirectorResult,
  key: "duration" | "continuity" | "referenceDelivery" | "resolution" | "aspectRatio" | "sound",
): string {
  const value = params[key];
  if (key === "duration") {
    if (typeof value === "number") return `${value} 秒`;
    if (typeof value === "string" && value) {
      if (value === "reference") return "跟随原视频";
      return value.replace(/s$/i, " 秒");
    }
    const matchedDuration = director.executionCard.duration.match(/\d+(?:\.\d+)?/);
    return matchedDuration ? `${matchedDuration[0]} 秒` : "自动判断";
  }
  if (key === "continuity") {
    return (
      {
        auto: "自动判断",
        single: "不拼接",
        stitch: "分段拼接",
        two_part: "两段拼接",
      }[String(value)] ?? ""
    );
  }
  if (key === "referenceDelivery") {
    if (value === "text_only") return "只要提示词";
    if (value === "images_text" || value === "images_only") return "图片 + 提示词";
    if (value === "video_images_text" || value === "allow_video") {
      return "视频 + 图片 + 提示词";
    }
    return director.uploadPlan.some((item) => item.type === "video")
      ? "含处理后参考视频"
      : "图片 + 提示词";
  }
  if (key === "resolution") {
    if (typeof value === "string" && value) return value.toUpperCase();
    const matchedResolution = director.executionCard.resolution.match(/(?:1080|720|480)/);
    return matchedResolution ? `${matchedResolution[0]}P` : "按当前界面选择";
  }
  if (key === "aspectRatio") {
    if (value === "reference") return "跟随原视频";
    if (typeof value === "string" && value) return value;
    const matchedRatio = director.executionCard.aspectRatio.match(/\d+\s*:\s*\d+/);
    return matchedRatio ? matchedRatio[0].replace(/\s/g, "") : "跟随原视频";
  }
  if (key === "sound") {
    const selected = {
      generate: "生成声音",
      reference_rhythm: "沿用原视频声音节奏",
      mute: "无声",
    }[String(value)];
    if (selected) return selected;
    if (/无声|静音|mute|silent/i.test(director.executionCard.audio)) return "无声";
    if (/参考|原音|对话|节奏|reference/i.test(director.executionCard.audio)) {
      return "沿用原视频声音节奏";
    }
    return "生成声音";
  }
  return "";
}

async function copyText(
  value: string,
  successMessage = "已复制提示词",
): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("浏览器拒绝复制");
    }
    toast.success(successMessage);
  } catch {
    toast.error("复制失败，请手动选择文本复制");
  }
}

export default function TaskResultSheet({
  task,
  open,
  loading = false,
  onClose,
  onChanged,
  onRefresh,
  onRetry,
}: {
  task: TaskOut | null;
  open: boolean;
  loading?: boolean;
  onClose: () => void;
  onChanged?: () => void;
  onRefresh?: (taskId: number) => Promise<boolean | void> | boolean | void;
  onRetry?: (task: TaskOut) => Promise<void> | void;
}) {
  const [analysisNote, setAnalysisNote] = useState("");
  const [confirming, setConfirming] = useState<"confirm" | "revise" | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [deliveryChoice, setDeliveryChoice] = useState<ReferenceDeliveryMode>(
    "images_text",
  );
  const [conversionSubmitting, setConversionSubmitting] = useState(false);
  const [conversionAccepted, setConversionAccepted] = useState(false);
  const [conversionCanceling, setConversionCanceling] = useState(false);
  const [conversionRefreshFailed, setConversionRefreshFailed] = useState(false);
  const conversionRefreshFailures = useRef(0);
  const [requestedDelivery, setRequestedDelivery] =
    useState<ReferenceDeliveryMode | null>(null);
  const [promptLanguage, setPromptLanguage] = useState<"zh" | "en">("zh");
  const [englishRequested, setEnglishRequested] = useState(false);
  const [translationSubmitting, setTranslationSubmitting] = useState(false);
  const [translationCanceling, setTranslationCanceling] = useState(false);
  useEffect(() => {
    setAnalysisNote("");
    setRetrying(false);
    setConversionSubmitting(false);
    setConversionAccepted(false);
    setConversionCanceling(false);
    setConversionRefreshFailed(false);
    conversionRefreshFailures.current = 0;
    setRequestedDelivery(null);
    setPromptLanguage("zh");
    setEnglishRequested(false);
    setTranslationSubmitting(false);
    setTranslationCanceling(false);
    setDeliveryChoice(normalizeReferenceDelivery(task?.params.referenceDelivery));
  }, [task?.id]);
  const isAutoEdit = task?.featureId === "auto_edit";
  const isWatermarkRemoval = task?.featureId === "watermark_removal";
  const isMediaTask = isAutoEdit || isWatermarkRemoval;
  const autoEditSummary = task
    ? isWatermarkRemoval
      ? "完整保留原片 · 原声保留"
      : `${getEditTemplate(task.params.editTemplateId)?.name ?? "自动精剪"} · ${autoEditLanguageLabel(task.params.subtitleLanguage)}`
    : "";
  const extra = useMemo(() => asRecord(task?.result?.extra), [task?.result?.extra]);
  const editingResult = useMemo(() => asRecord(extra?.editing), [extra?.editing]);
  const autoEditAttentionNote = asString(editingResult?.attentionNote) || (isWatermarkRemoval &&
    /待完善|未处理|未完成|未能安全|未发现|没有发现/u.test(task?.message ?? "") ? "视频已保留，请核对水印处理说明。" : "");
  const autoEditNarrationNote = asString(editingResult?.narrationNote);
  const narrationState = task?.narrationStatus || asString(editingResult?.narrationStatus);
  const narrationDelivered = narrationState
    ? ["delivered", "repaired_continuous_delivery", "repaired_full_delivery"].includes(narrationState)
    : autoEditNarrationNote.startsWith("已补充");
  const autoEditNarrationMissing = isAutoEdit && task?.params.editVoice === "narration"
    && !narrationDelivered;
  const editingVideo = useMemo(() => {
    const media = Array.isArray(task?.result?.media) ? task.result.media : [];
    for (const value of media) {
      const item = asRecord(value);
      if (!item || asString(item.type) !== "video") continue;
      const url = asString(item.url);
      if (url) return { url, title: asString(item.title) || (isWatermarkRemoval ? "去水印视频" : "剪辑成片") };
    }
    const fallbackUrl = asString(editingResult?.videoUrl);
    return fallbackUrl ? { url: fallbackUrl, title: isWatermarkRemoval ? "去水印视频" : "剪辑成片" } : null;
  }, [editingResult?.videoUrl, isWatermarkRemoval, task?.result?.media]);
  const director = useMemo(() => normalizeDirector(extra?.director), [extra?.director]);
  const deliveryPackage = task?.deliveryPackage;
  const promptTranslation = task?.promptTranslation;
  const translationStatus = promptTranslation?.status ?? "idle";
  const translationActive =
    translationStatus === "pending" || translationStatus === "running";
  const deliveryConversion = deliveryPackage?.conversion;
  const conversionStatus = deliveryConversion?.status ?? "";
  const conversionTarget = deliveryConversion?.targetMode
    ? normalizeReferenceDelivery(deliveryConversion.targetMode)
    : null;
  const conversionError = deliveryConversion?.error ?? "";
  const currentDelivery = deliveryPackage?.currentMode
    ? normalizeReferenceDelivery(deliveryPackage.currentMode)
    : normalizeReferenceDelivery(task?.params.referenceDelivery);
  const serverAllowedModes = referenceDeliveryModes(deliveryPackage?.allowedModes);
  const cachedDeliveryModes = referenceDeliveryModes(deliveryPackage?.cachedModes);
  const hasServerAllowedModes = Boolean(
    deliveryPackage && Array.isArray(deliveryPackage.allowedModes),
  );
  const routeAllowsVideo = Boolean(
    task?.videoId &&
      director?.routing?.mode !== "ORIGINAL" &&
      director?.routing?.mode !== "VIRAL_ADAPTATION" &&
      task?.featureId !== "video_breakdown",
  );
  const allowedDeliveryModes =
    hasServerAllowedModes
      ? serverAllowedModes
      : ([
          "text_only",
          "images_text",
          ...(routeAllowsVideo ? (["video_images_text"] as const) : []),
        ] as ReferenceDeliveryMode[]);
  const conversionActive =
    conversionStatus === "pending" || conversionStatus === "running";
  const conversionBusy =
    conversionSubmitting ||
    conversionAccepted ||
    conversionActive ||
    Boolean(
      requestedDelivery &&
        requestedDelivery !== currentDelivery &&
        conversionStatus !== "failed",
    );
  const providedAssets = useMemo(
    () =>
      Array.isArray(extra?.inputAssets)
        ? extra.inputAssets.flatMap((value): ProvidedTaskAsset[] => {
            const asset = asRecord(value);
            if (!asset) return [];
            const assetKey = asString(asset.assetKey);
            const name = asString(asset.name);
            const type = asString(asset.type);
            const url = asString(asset.url);
            return assetKey && name && url
              ? [{ assetKey, name, type, url }]
              : [];
          })
        : [],
    [extra?.inputAssets],
  );
  useEffect(() => {
    if (!task) return;
    if (conversionActive && conversionTarget) {
      setConversionAccepted(false);
      setDeliveryChoice(conversionTarget);
      return;
    }
    if (conversionStatus === "failed") {
      setConversionAccepted(false);
      return;
    }
    setDeliveryChoice(currentDelivery);
    if (requestedDelivery === currentDelivery) {
      setConversionAccepted(false);
      setRequestedDelivery(null);
    }
  }, [
    conversionActive,
    conversionStatus,
    conversionTarget,
    currentDelivery,
    requestedDelivery,
    task?.id,
  ]);

  useEffect(() => {
    if (!conversionBusy || !onRefresh) return;
    const refresh = async () => {
      if (document.visibilityState === "visible" && task) {
        const refreshed = await onRefresh(task.id);
        if (refreshed === false) {
          conversionRefreshFailures.current += 1;
          if (conversionRefreshFailures.current >= 2) {
            setConversionRefreshFailed(true);
          }
          return;
        }
        conversionRefreshFailures.current = 0;
        setConversionRefreshFailed(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [conversionBusy, onRefresh, task?.id]);

  const prompt = director ? selectFinalSeedancePrompt(director.prompts) : null;
  const sourcePromptContent = prompt?.content ?? "";
  const translatedPromptContent = promptTranslation?.translatedPrompt ?? "";
  const displayedPromptContent =
    promptLanguage === "en" && translationStatus === "succeeded"
      ? translatedPromptContent
      : sourcePromptContent;

  useEffect(() => {
    setPromptLanguage("zh");
    setEnglishRequested(false);
  }, [task?.id, sourcePromptContent]);

  useEffect(() => {
    if (englishRequested && translationStatus === "succeeded") {
      setPromptLanguage("en");
      setEnglishRequested(false);
    }
  }, [englishRequested, translationStatus]);

  useEffect(() => {
    if ((!translationActive && !translationSubmitting) || !onRefresh) return;
    const refresh = () => {
      if (document.visibilityState === "visible" && task) void onRefresh(task.id);
    };
    const timer = window.setInterval(refresh, 2500);
    return () => window.clearInterval(timer);
  }, [onRefresh, task, translationActive, translationSubmitting]);
  if (!task) return null;
  const originalBrief = String(task.featureId === "voice_clone" ? task.params.text ?? "" : task.params.brief ?? "").trim();
  const meta = taskStatusMeta(task);
  const faceReferencePolicy =
    extra?.faceReferencePolicy === "faces_allowed" ||
    task.params.faceReferencePolicy === "faces_allowed"
      ? "faces_allowed"
      : "no_faces";
  const displayParams =
    task.featureId === "video_breakdown" ||
    director?.routing?.mode === "VIRAL_ADAPTATION"
      ? {
          ...task.params,
          referenceDelivery:
            currentDelivery === "text_only"
              ? "text_only"
              : "images_text",
        }
      : { ...task.params, referenceDelivery: currentDelivery };
  const settings = director
    ? [
        ["时长", settingValue(displayParams, director, "duration")],
        ["拼接", settingValue(displayParams, director, "continuity")],
        ["参考方式", settingValue(displayParams, director, "referenceDelivery")],
        ["素材", faceReferencePolicy === "faces_allowed" ? "可以露脸" : "不能露脸"],
        ["声音", settingValue(displayParams, director, "sound")],
      ].filter((item) => item[1])
    : [];
  const progressText = task.featureId === "voice_clone" ? task.message || "正在准备配音" : isWatermarkRemoval
    ? task.progress < 10
      ? "等待开始"
      : task.progress < 42
        ? "正在扫描整条视频"
        : task.progress < 69
          ? "正在判断安全处理范围"
          : task.progress < 98
            ? "正在处理并检查结果"
            : "正在整理去水印视频"
    : isAutoEdit
    ? autoEditProgressText(task.progress, task.status, task.params.transcribe !== false)
    : task.progress < 10
      ? "等待开始"
      : task.progress < 55
        ? task.videoId
          ? "正在读视频"
          : "正在整理你的素材"
        : task.params.analysisConfirmed !== true
          ? task.featureId === "video_breakdown"
            ? "正在抓住参考片的爆点"
            : task.featureId === "video_replication"
              ? "正在看懂动作、镜头和节奏"
              : "正在理解你的想法"
        : task.progress < 95
          ? "正在生成提示词"
          : "正在整理附件";
  const visibleDeliveryOptions = DELIVERY_OPTIONS.filter(
    (option) =>
      option.value !== "video_images_text" ||
      allowedDeliveryModes.includes(option.value) ||
      currentDelivery === option.value,
  );
  const selectedDeliveryNeedsWork =
    deliveryChoice !== "text_only" &&
    !cachedDeliveryModes.includes(deliveryChoice) &&
    deliveryChoice !== currentDelivery;
  const conversionTargetLabel = DELIVERY_OPTIONS.find(
    (option) => option.value === (conversionTarget ?? requestedDelivery),
  )?.label;

  const submitUnderstanding = async (action: "confirm" | "revise") => {
    setConfirming(action);
    try {
      const response = await fetch(`/api/tasks/${task.id}/confirm-analysis`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note: analysisNote.trim() }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) throw new Error(data.error || "确认失败");
      toast.success(
        data.message ||
          (action === "revise" ? "正在重新理解" : "方向已确认"),
      );
      onChanged?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "确认失败");
    } finally {
      setConfirming(null);
    }
  };

  const submitDeliveryChange = async () => {
    if (
      deliveryChoice === currentDelivery ||
      !allowedDeliveryModes.includes(deliveryChoice) ||
      conversionBusy ||
      translationActive ||
      translationSubmitting
    ) {
      return;
    }
    setConversionSubmitting(true);
    setRequestedDelivery(deliveryChoice);
    try {
      const response = await apiSend<{
        message?: string;
        deliveryPackage?: unknown;
      }>(`/api/tasks/${task.id}/delivery-package`, "POST", {
        targetMode: deliveryChoice,
      });
      setConversionAccepted(true);
      toast.success(response.message || "正在转换交付方式");
      await onRefresh?.(task.id);
    } catch (error) {
      setConversionAccepted(false);
      setRequestedDelivery(null);
      toast.error(error instanceof Error ? error.message : "转换失败，请再试一次");
    } finally {
      setConversionSubmitting(false);
    }
  };

  const cancelDeliveryChange = async () => {
    if (!conversionBusy || conversionSubmitting || conversionCanceling) return;
    setConversionCanceling(true);
    try {
      const response = await apiSend<{ message?: string }>(
        `/api/tasks/${task.id}/delivery-package`,
        "DELETE",
      );
      setConversionAccepted(false);
      setRequestedDelivery(null);
      toast.success(response.message || "已取消切换，原结果仍可使用");
      await onRefresh?.(task.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "取消失败，请再试一次");
    } finally {
      setConversionCanceling(false);
    }
  };

  const chooseEnglishPrompt = async () => {
    if (translationStatus === "succeeded" && translatedPromptContent) {
      setPromptLanguage("en");
      return;
    }
    if (!task.canManage || translationSubmitting || translationActive || conversionBusy) {
      return;
    }
    setEnglishRequested(true);
    setTranslationSubmitting(true);
    try {
      const response = await apiSend<{ message?: string }>(
        `/api/tasks/${task.id}/prompt-translation`,
        "POST",
      );
      toast.success(response.message || "正在生成英文版本");
      await onRefresh?.(task.id);
    } catch (error) {
      setEnglishRequested(false);
      toast.error(error instanceof Error ? error.message : "英文翻译失败，请再试一次");
    } finally {
      setTranslationSubmitting(false);
    }
  };

  const cancelPromptTranslation = async () => {
    if (!translationActive || translationCanceling) return;
    setTranslationCanceling(true);
    try {
      const response = await apiSend<{ message?: string }>(
        `/api/tasks/${task.id}/prompt-translation`,
        "DELETE",
      );
      setEnglishRequested(false);
      toast.success(response.message || "已取消翻译，中文仍可使用");
      await onRefresh?.(task.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "取消失败，请再试一次");
    } finally {
      setTranslationCanceling(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <SheetContent
        aria-busy={task.status === "pending" || task.status === "running"}
        className="w-full overflow-y-auto overscroll-contain pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:max-w-3xl"
      >
        <SheetHeader>
          <div className="flex items-center gap-2 pr-6">
            <SheetTitle>任务 #{task.id}</SheetTitle>
            <Badge variant={meta.variant}>{meta.label}</Badge>
          </div>
          <SheetDescription className="line-clamp-2">
            {task.featureIcon} {task.featureName}
            {task.videoId ? ` · ${task.videoName}` : ""}
            {task.secondaryVideoId ? ` + ${task.secondaryVideoName}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-5 space-y-6">
          {loading && !director && (
            <div
              aria-live="polite"
              className="flex items-center gap-2 rounded-xl border bg-zinc-50 px-4 py-3 text-sm text-muted-foreground"
            >
              <Loader2
                aria-hidden="true"
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
              />
              正在打开…
            </div>
          )}
          {(task.status === "pending" || task.status === "running") && (
            <div className="overflow-hidden rounded-2xl border bg-gradient-to-br from-zinc-50 to-white p-5 shadow-sm">
              <div aria-live="polite" className="flex items-center text-sm">
                <span className="font-medium">{progressText}</span>
              </div>
              <LiveProgress value={task.progress} className="mt-3" />
            </div>
          )}

          {task.error && (
            <div className="flex gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-medium">这次没有交出成品</p>
                <p className="mt-1 break-words leading-relaxed">{task.error}</p>
                {task.status === "failed" && task.canManage && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {onRetry && (
                      <Button
                        type="button"
                        size="sm"
                        className="bg-red-600 text-white hover:bg-red-700"
                        disabled={retrying}
                        onClick={async () => {
                          setRetrying(true);
                          try {
                            await onRetry(task);
                          } finally {
                            setRetrying(false);
                          }
                        }}
                      >
                        {retrying ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        {isWatermarkRemoval ? "再处理一次" : isAutoEdit ? "再剪一次" : "自动修正并继续"}
                      </Button>
                    )}
                    {originalBrief && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="border-red-200 bg-white text-red-700 hover:bg-red-100 hover:text-red-800"
                        onClick={() => void copyText(originalBrief, "已复制原要求")}
                      >
                        <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                        复制原要求
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {isMediaTask && task.status === "succeeded" && (
            <section className="overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm">
              <div className="flex items-center gap-3 border-b border-zinc-100 px-4 py-4 sm:px-5">
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${
                  autoEditAttentionNote || autoEditNarrationMissing
                    ? "bg-amber-50 text-amber-700"
                    : "bg-emerald-50 text-emerald-700"
                }`}>
                  {autoEditAttentionNote || autoEditNarrationMissing ? (
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Check className="h-4 w-4" aria-hidden="true" />
                  )}
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-zinc-950">
                    {autoEditNarrationMissing
                      ? narrationState === "partial" ? "精剪已完成，配音待完善" : "精剪已完成，配音未完成"
                      : autoEditAttentionNote
                      ? "成片已保留，请确认"
                      : isWatermarkRemoval ? "水印处理已完成" : "成片已剪好"}
                  </h3>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {autoEditSummary} · 可以直接播放或下载
                  </p>
                </div>
                {editingVideo && (
                  <Button asChild size="sm" className="ml-auto shrink-0">
                    <a href={editingVideo.url} download>
                      <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      {isWatermarkRemoval ? "下载视频" : "下载成片"}
                    </a>
                  </Button>
                )}
              </div>
              {autoEditAttentionNote && (
                <div className="flex flex-col gap-3 border-b border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-5 text-amber-900 sm:flex-row sm:items-center sm:px-5">
                  <p className="flex min-w-0 flex-1 items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>请重点检查：{autoEditAttentionNote}</span>
                  </p>
                  {onRetry && task.canManage && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="shrink-0 border-amber-300 bg-white text-amber-900 hover:bg-amber-100 hover:text-amber-950"
                      disabled={retrying}
                      onClick={async () => {
                        setRetrying(true);
                        try {
                          await onRetry(task);
                        } finally {
                          setRetrying(false);
                        }
                      }}
                    >
                      {retrying ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                      ) : (
                        <RotateCcw className="h-3.5 w-3.5" />
                      )}
                      {isWatermarkRemoval ? "再处理一次" : "再剪一次"}
                    </Button>
                  )}
                </div>
              )}
              {autoEditNarrationMissing && (
                <div role="alert" className="border-b border-amber-100 bg-amber-50 px-4 py-3 text-sm leading-5 text-amber-900 sm:px-5">
                  <p className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{autoEditNarrationNote || "这条成片没有加入画外解说，目前只有原声精剪版。"}</span>
                  </p>
                </div>
              )}
              {editingVideo ? (
                <div className="bg-zinc-950 p-2 sm:p-3">
                  <video
                    key={editingVideo.url}
                    controls
                    preload="metadata"
                    playsInline
                    className="mx-auto max-h-[68dvh] w-full rounded-xl bg-black object-contain"
                    src={editingVideo.url}
                    aria-label={editingVideo.title}
                  />
                </div>
              ) : (
                <p className="px-5 py-8 text-center text-sm text-zinc-500">
                  {typeof task.result?.message === "string"
                    ? task.result.message
                    : "成片文件还在整理，稍后刷新即可查看。"}
                </p>
              )}
            </section>
          )}

          {!isMediaTask && director && (
            <>
              {director.understanding && task.status === "awaiting_confirmation" && (
                <section className="overflow-hidden rounded-2xl border border-violet-100 bg-gradient-to-br from-violet-50/80 via-white to-amber-50/50 p-5">
                  <div className="flex items-start gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-zinc-950 text-white shadow-sm">
                      <Sparkles className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-violet-700">
                        {director.routing
                          ? routeLabel(director.routing.mode)
                          : "我先说说自己看懂了什么"}
                      </p>
                      <h3 className="mt-1 text-lg font-semibold tracking-tight">
                        {director.understanding.title}
                      </h3>
                    </div>
                  </div>
                  <ul className="mt-4 space-y-2 text-sm leading-6 text-zinc-700">
                    {director.understanding.viralCore.map((item) => (
                      <li key={item} className="flex gap-2">
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-violet-500" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-4 whitespace-pre-line rounded-xl bg-white/80 p-4 text-sm leading-6 text-zinc-700 ring-1 ring-black/5">
                    <span className="font-medium text-zinc-950">
                      {task.featureId === "video_breakdown"
                        ? "我准备这样重构："
                        : task.featureId === "video_replication"
                          ? "我准备这样复刻："
                          : "我准备这样做："}
                    </span>
                    {"\n"}
                    {director.understanding.adaptation}
                  </div>
                  {task.status === "awaiting_confirmation" && task.canManage && (
                    <div className="mt-5 border-t border-violet-100 pt-5">
                      <label htmlFor={`analysis-note-${task.id}`} className="text-sm font-medium">
                        不对的地方，直接告诉我
                      </label>
                      <Textarea
                        id={`analysis-note-${task.id}`}
                        className="mt-2 min-h-24 bg-white"
                        maxLength={3000}
                        name="analysis-note"
                        autoComplete="off"
                        placeholder="哪里不对就直接说，例如：不要照抄动作，保留反转就行……"
                        value={analysisNote}
                        onChange={(event) => setAnalysisNote(event.target.value)}
                      />
                      <p className="mt-2 text-xs text-muted-foreground">确认后开始制作附件和提示词。</p>
                      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
                        {analysisNote.trim() && (
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void submitUnderstanding("revise")}
                            disabled={confirming !== null}
                          >
                            {confirming === "revise" ? "正在重新理解…" : "按我的补充重新理解"}
                          </Button>
                        )}
                        <Button
                          type="button"
                          onClick={() => void submitUnderstanding("confirm")}
                          disabled={confirming !== null || Boolean(analysisNote.trim())}
                        >
                          {confirming === "confirm" ? "正在确认…" : "理解没错，开始制作"}
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {task.status === "succeeded" && director.status !== "ready" && (
              <div
                className="flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">还需要补充后才能制作最终提示词</p>
                </div>
              </div>
              )}

              {task.status !== "awaiting_confirmation" && settings.length > 0 && (
                <section>
                  <h3 className="text-sm font-semibold">生成设置</h3>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {settings.map(([label, value]) => (
                      <div
                        key={label}
                        className="rounded-lg border bg-background px-3 py-2 text-xs"
                      >
                        <span className="text-muted-foreground">{label}</span>
                        <span className="ml-2 font-medium">{value}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {task.status === "succeeded" &&
                director.status === "ready" &&
                task.canManage && (
                  <section
                    aria-busy={conversionBusy}
                    className="rounded-2xl border bg-zinc-50/70 p-4"
                  >
                    <fieldset
                      disabled={conversionBusy || translationActive || translationSubmitting}
                    >
                      <legend className="text-sm font-semibold">
                        换个交付方式
                      </legend>
                      <div
                        className={`mt-3 grid gap-2 ${
                          visibleDeliveryOptions.length === 3
                            ? "sm:grid-cols-3"
                            : "grid-cols-2"
                        }`}
                      >
                        {visibleDeliveryOptions.map((option) => {
                          const isCurrent = option.value === currentDelivery;
                          const isAllowed = allowedDeliveryModes.includes(
                            option.value,
                          );
                          return (
                            <label
                              key={option.value}
                              className={`relative flex min-h-11 touch-manipulation cursor-pointer items-center justify-center rounded-xl border px-3 py-2 text-center text-xs font-medium transition-[border-color,background-color,color,box-shadow] hover:border-zinc-400 ${
                                deliveryChoice === option.value
                                  ? "border-zinc-950 bg-zinc-950 text-white shadow-sm"
                                  : "border-zinc-200 bg-white text-zinc-700"
                              } ${
                                !isAllowed
                                  ? "cursor-not-allowed opacity-50"
                                  : conversionBusy || translationActive || translationSubmitting
                                    ? "cursor-wait opacity-60"
                                    : ""
                              }`}
                            >
                              <input
                                className="peer sr-only"
                                type="radio"
                                name={`delivery-mode-${task.id}`}
                                value={option.value}
                                checked={deliveryChoice === option.value}
                                disabled={
                                  conversionBusy ||
                                  translationActive ||
                                  translationSubmitting ||
                                  !isAllowed
                                }
                                onChange={() => setDeliveryChoice(option.value)}
                              />
                              <span className="flex items-center gap-1.5 peer-focus-visible:rounded peer-focus-visible:ring-2 peer-focus-visible:ring-violet-400 peer-focus-visible:ring-offset-2">
                                {isCurrent && (
                                  <Check aria-hidden="true" className="h-3.5 w-3.5" />
                                )}
                                {option.label}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>

                    <div className="mt-3 flex min-h-9 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div
                        aria-live="polite"
                        className={`min-w-0 break-words text-xs ${
                          conversionStatus === "failed"
                            ? "text-red-600"
                            : "text-muted-foreground"
                        }`}
                      >
                        {translationActive
                          ? "英文版生成完成后即可切换；也可以在提示词处取消翻译"
                          : conversionRefreshFailed
                          ? "状态刷新失败，原结果仍可使用"
                          : conversionBusy
                          ? `正在换成“${conversionTargetLabel || "新方式"}”，当前结果仍可使用`
                          : conversionStatus === "failed"
                            ? `没转换好，原结果仍可用。${conversionError || "可以再试一次"}`
                            : selectedDeliveryNeedsWork
                              ? "会补齐附件"
                              : deliveryChoice !== currentDelivery &&
                                  cachedDeliveryModes.includes(deliveryChoice)
                                ? "可以立即切换"
                                : ""}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {conversionRefreshFailed && onRefresh && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => void onRefresh(task.id)}
                          >
                            刷新状态
                          </Button>
                        )}
                        {conversionBusy && !conversionSubmitting && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={conversionCanceling}
                            onClick={() => void cancelDeliveryChange()}
                          >
                            {conversionCanceling ? "正在取消…" : "取消切换"}
                          </Button>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          disabled={
                            conversionBusy ||
                            translationActive ||
                            translationSubmitting ||
                            deliveryChoice === currentDelivery ||
                            !allowedDeliveryModes.includes(deliveryChoice)
                          }
                          onClick={() => void submitDeliveryChange()}
                        >
                          {conversionBusy && (
                            <Loader2
                              aria-hidden="true"
                              className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                            />
                          )}
                          {conversionBusy
                            ? "正在转换…"
                            : conversionStatus === "failed" &&
                                deliveryChoice === conversionTarget
                              ? "再试一次"
                              : deliveryChoice === currentDelivery
                                ? "当前方式"
                                : cachedDeliveryModes.includes(deliveryChoice)
                                  ? "立即切换"
                                  : "转换交付方式"}
                        </Button>
                      </div>
                    </div>
                  </section>
                )}

              {task.status !== "awaiting_confirmation" &&
                currentDelivery !== "text_only" && (
                  <TaskGeneratedImages
                    taskId={task.id}
                    active={open && task.status === "succeeded"}
                    canManage={task.canManage}
                    requirements={director.requiredAssets}
                    uploadPlan={director.uploadPlan}
                    providedAssets={providedAssets}
                    faceReferencePolicy={faceReferencePolicy}
                  />
                )}

              {task.status !== "awaiting_confirmation" && prompt && (
                <section>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold">视频提示词</h3>
                  </div>
                  <div className="mt-3 overflow-hidden rounded-xl border bg-background">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/20 px-4 py-3">
                      <div className="flex items-center gap-1 rounded-lg border bg-white p-1">
                        <button
                          type="button"
                          className={`min-h-8 rounded-md px-3 text-xs font-medium transition-colors ${
                            promptLanguage === "zh"
                              ? "bg-zinc-950 text-white"
                              : "text-zinc-600 hover:bg-zinc-100"
                          }`}
                          onClick={() => setPromptLanguage("zh")}
                        >
                          中文
                        </button>
                        <button
                          type="button"
                          className={`min-h-8 rounded-md px-3 text-xs font-medium transition-colors ${
                            promptLanguage === "en"
                              ? "bg-zinc-950 text-white"
                              : "text-zinc-600 hover:bg-zinc-100"
                          } disabled:cursor-wait disabled:opacity-60`}
                          disabled={conversionBusy || translationSubmitting || translationActive}
                          onClick={() => void chooseEnglishPrompt()}
                        >
                          {translationSubmitting || translationActive ? "翻译中…" : "English"}
                        </button>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => void copyText(displayedPromptContent)}
                        disabled={!displayedPromptContent}
                      >
                        <Copy aria-hidden="true" className="h-3.5 w-3.5" />
                        复制提示词
                      </Button>
                    </div>
                    {(translationActive || translationStatus === "failed") && (
                      <div
                        aria-live="polite"
                        className={`flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-xs ${
                          translationStatus === "failed"
                            ? "bg-red-50 text-red-700"
                            : "bg-violet-50 text-violet-700"
                        }`}
                      >
                        <span>
                          {translationActive
                            ? "正在生成英文版，中文仍可复制"
                            : promptTranslation?.error || "英文没有翻译好，中文仍可使用"}
                        </span>
                        {translationActive && (
                          <button
                            type="button"
                            className="font-medium underline underline-offset-2"
                            disabled={translationCanceling}
                            onClick={() => void cancelPromptTranslation()}
                          >
                            {translationCanceling ? "正在取消…" : "取消"}
                          </button>
                        )}
                      </div>
                    )}
                    <div className="max-h-[34rem] overflow-y-auto whitespace-pre-wrap break-words p-4 text-sm leading-7">
                      {displayedPromptContent || "未生成提示词"}
                    </div>
                      </div>
                </section>
              )}
            </>
          )}

          {!loading && !isMediaTask && !director && task.status === "succeeded" && (
            <div className="space-y-3 rounded-xl border p-4 text-sm">
              {typeof task.result?.message === "string"
                ? task.result.message
                : "任务已完成，但没有可展示的提示词。"}
              {task.featureId === "voice_clone" && <>
                <audio controls preload="none" src={`/api/tasks/${task.id}/artifacts/voice/final.wav`} className="w-full" />
                <a className="block text-indigo-600 underline" href={`/api/tasks/${task.id}/artifacts/voice/final.wav`} download={`voice-${task.id}.wav`}>下载配音</a>
                <a className="block text-indigo-600 underline" href="/voices">使用这个音色继续配音</a>
              </>}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

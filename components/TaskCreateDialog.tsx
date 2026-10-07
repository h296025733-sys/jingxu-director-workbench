"use client";
import { EditTemplatePicker } from "./EditTemplatePicker";
import { DEFAULT_EDIT_TEMPLATE, EDIT_TEMPLATE_VERSION, getEditTemplate, normalizePreviewVoice, previewVoiceGender } from "@/lib/edit-templates";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  Clock3,
  Copy,
  Eraser,
  FileImage,
  Film,
  Loader2,
  PencilLine,
  Plus,
  Scissors,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import { apiGet, apiSend } from "@/lib/client";
import { cn } from "@/lib/utils";
import type { VideoOut } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  generateVideoThumbnail,
  getVideoUploadRecovery,
  uploadVideoFile,
} from "@/lib/video-client";
import { useThrottledValue } from "@/lib/use-throttled-value";
import {
  AUTO_EDIT_DEFAULT_BRIEF,
  AUTO_EDIT_DEFAULT_PARAMS,
} from "@/lib/auto-edit-defaults";
import {
  bracketInputReference,
  inputImageLabel,
  inputVideoLabel,
} from "@/lib/input-reference-labels";
import { toast } from "sonner";

export interface FeatureMeta {
  id: string;
  name: string;
  description: string;
  icon: string;
  status: "ready" | "developing";
  inputSchema: {
    type: "object";
    required?: string[];
    properties: Record<
      string,
      {
        type: string;
        title: string;
        description?: string;
        placeholder?: string;
        default?: unknown;
        enum?: { label: string; value: string }[];
        accept?: string;
        multiple?: boolean;
        maxFiles?: number;
        required?: boolean;
        min?: number;
        max?: number;
        step?: number;
        uiLayout?: "full" | "half" | "hidden";
      }
    >;
  };
}

interface InstructionHistoryItem {
  id: number;
  taskId: number;
  kind: "create" | "revision";
  instruction: string;
  createdAt: string;
  taskStatus: string | null;
}

let cachedReadyFeatures: FeatureMeta[] | null = null;

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatHistoryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function historyTaskStatus(value: string | null): string {
  if (value === "failed") return "失败";
  if (value === "canceled") return "已取消";
  if (value === "succeeded") return "已完成";
  if (value === "awaiting_confirmation") return "待确认";
  if (value === "pending" || value === "running") return "制作中";
  return "";
}

async function copyInstruction(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("复制失败");
}

function initialParams(feature: FeatureMeta): Record<string, unknown> {
  const schemaDefaults = Object.fromEntries(
    Object.entries(feature.inputSchema.properties)
      .filter(([, field]) => field.type !== "file" && field.default !== undefined)
      .map(([key, field]) => [key, field.default]),
  );
  if (feature.id !== "auto_edit") return schemaDefaults;
  return {
    ...AUTO_EDIT_DEFAULT_PARAMS,
    ...schemaDefaults,
  };
}

async function cleanupUploadedAssets(assetIds: string[]): Promise<number> {
  let failed = 0;
  for (const assetId of assetIds) {
    try {
      const response = await fetch(`/api/assets/${encodeURIComponent(assetId)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (!response.ok) failed += 1;
    } catch {
      failed += 1;
    }
  }
  return failed;
}

function ChoiceCards({
  value,
  onChange,
  options,
  columns = 2,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; note?: string; disabled?: boolean }>;
  columns?: 2 | 3;
}) {
  return (
    <div
      className={cn(
        "grid gap-2",
        columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2",
      )}
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative rounded-xl border px-3.5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
              active
                ? "border-indigo-500 bg-indigo-50/80 text-indigo-950"
                : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50",
            )}
          >
            <span className="flex items-center justify-between gap-2 text-sm font-medium">
              {option.label}
              {active && <Check className="h-3.5 w-3.5 text-indigo-600" />}
            </span>
            {option.note && (
              <span className="mt-1 block text-[11px] leading-4 text-zinc-500">
                {option.note}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function ImagePicker({
  files,
  onChange,
  onInsertReference,
  disabled,
}: {
  files: Array<{ file: File; referenceNumber: number }>;
  onChange: (files: Array<{ file: File; referenceNumber: number }>) => void;
  onInsertReference: (label: string) => void;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const add = (picked: File[]) => {
    const uniquePicked = picked.filter(
      (file, index, all) =>
        all.findIndex(
          (candidate) =>
            candidate.name === file.name &&
            candidate.size === file.size &&
            candidate.lastModified === file.lastModified,
        ) === index &&
        !files.some(
          (selected) =>
            selected.file.name === file.name &&
            selected.file.size === file.size &&
            selected.file.lastModified === file.lastModified,
        ),
    );
    let nextReferenceNumber = files.reduce(
      (largest, selected) => Math.max(largest, selected.referenceNumber),
      0,
    );
    const next = [
      ...files,
      ...uniquePicked.map((file) => ({
        file,
        referenceNumber: (nextReferenceNumber += 1),
      })),
    ];
    if (next.length > 9) toast.error("最多选择 9 张图片");
    onChange(next.slice(0, 9));
  };
  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          add(Array.from(event.target.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="flex w-full items-center gap-3 rounded-xl border border-dashed border-zinc-300 bg-white px-3.5 py-3 text-left hover:border-indigo-300 hover:bg-indigo-50/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-zinc-100 text-zinc-700">
          <FileImage className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">添加图片</span>
          <span className="block text-[11px] text-zinc-500">人物、产品、场景都可以</span>
        </span>
        <Plus className="h-4 w-4 text-zinc-400" />
      </button>
      {files.length > 0 && (
        <div className="space-y-1 rounded-xl border bg-zinc-50/70 p-2">
          {files.map((selected, index) => {
            const label = inputImageLabel(selected.referenceNumber);
            return (
            <div
              key={`${selected.file.name}-${selected.file.size}-${selected.file.lastModified}`}
              className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-2 text-xs"
            >
              <FileImage className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
              <button
                type="button"
                onClick={() => onInsertReference(label)}
                className="shrink-0 rounded-md bg-indigo-50 px-2 py-1 font-medium text-indigo-700 hover:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                aria-label={`把${label}写入需求`}
              >
                {label}
              </button>
              <span className="min-w-0 flex-1 truncate">{selected.file.name}</span>
              <span className="shrink-0 text-zinc-400">{formatFileSize(selected.file.size)}</span>
              <button
                type="button"
                aria-label={`移除图片 ${selected.file.name}`}
                onClick={() => onChange(files.filter((_, itemIndex) => itemIndex !== index))}
                className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function TaskCreateDialog({
  open,
  onClose,
  onCreated,
  initialVideoId,
  initialFeatureId,
  embedded = false,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  initialVideoId?: string;
  initialFeatureId?: string;
  embedded?: boolean;
}) {
  const [videos, setVideos] = useState<VideoOut[]>([]);
  const [voiceReferences, setVoiceReferences] = useState<VideoOut[]>([]);
  const [readyFeatures, setReadyFeatures] = useState<FeatureMeta[]>([]);
  const [feature, setFeature] = useState<FeatureMeta | null>(null);
  const [videoId, setVideoId] = useState("");
  const [secondaryVideoId, setSecondaryVideoId] = useState("");
  const [voiceSource, setVoiceSource] = useState<"built_in" | "uploaded" | "personal">("built_in");
  const [personalVoices, setPersonalVoices] = useState<{ id: string; name: string; status: string }[]>([]);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [images, setImages] = useState<
    Array<{ file: File; referenceNumber: number }>
  >([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState("");
  const {
    value: videoUpload,
    update: updateVideoUpload,
    updateNow: setVideoUploadNow,
  } = useThrottledValue<{
      name: string;
      percent: number;
      phase: "uploading" | "saving";
      bytesPerSecond: number;
      statusText?: string;
      slot: "primary" | "secondary" | "voice";
    } | null>(null, 120);
  const [videoDragging, setVideoDragging] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [instructionHistory, setInstructionHistory] = useState<
    InstructionHistoryItem[]
  >([]);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const secondaryVideoInputRef = useRef<HTMLInputElement>(null);
  const voiceVideoInputRef = useRef<HTMLInputElement>(null);
  const briefInputRef = useRef<HTMLTextAreaElement>(null);
  const videoUploadControllerRef = useRef<AbortController | null>(null);
  const historyControllerRef = useRef<AbortController | null>(null);
  const selectedVideo = videos.find((video) => video.id === videoId);
  const selectedSecondaryVideo = videos.find(
    (video) => video.id === secondaryVideoId,
  );
  const selectableVoiceReferences = [
    ...videos,
    ...voiceReferences.filter(
      (reference) => !videos.some((video) => video.id === reference.id),
    ),
  ];
  const selectedVoiceVideo = selectableVoiceReferences.find(
    (media) => media.id === params.voiceReferenceVideoId,
  );
  const busy = submitting || videoUpload !== null;
  const isAutoEdit = feature?.id === "auto_edit";
  const isWatermarkRemoval = feature?.id === "watermark_removal";
  const isMediaTask = isAutoEdit || isWatermarkRemoval;

  const updateParam = (key: string, value: unknown) => {
    setParams((previous) => ({ ...previous, [key]: value }));
  };

  const switchFeature = (featureId: string) => {
    if (busy || feature?.id === featureId) return;
    const nextFeature = readyFeatures.find((item) => item.id === featureId);
    if (!nextFeature) return;
    setFeature(nextFeature);
    if (nextFeature.id !== "auto_edit") setSecondaryVideoId("");
    setVoiceSource("built_in");
    setParams((previous) => ({
      ...initialParams(nextFeature),
      brief:
        nextFeature.id === "auto_edit"
          ? AUTO_EDIT_DEFAULT_BRIEF
          : nextFeature.id === "watermark_removal" || isMediaTask
            ? ""
            : previous.brief ?? "",
    }));
    setSubmitStatus("");
  };

  const insertBriefReference = (label: string) => {
    const input = briefInputRef.current;
    const current = String(params.brief ?? "");
    const start = input?.selectionStart ?? current.length;
    const end = input?.selectionEnd ?? start;
    const token = bracketInputReference(label);
    const prefix = start > 0 && !/\s$/.test(current.slice(0, start)) ? " " : "";
    const suffix = end < current.length && !/^\s/.test(current.slice(end)) ? " " : "";
    const next = `${current.slice(0, start)}${prefix}${token}${suffix}${current.slice(end)}`;
    const caret = start + prefix.length + token.length + suffix.length;
    updateParam("brief", next);
    requestAnimationFrame(() => {
      briefInputRef.current?.focus();
      briefInputRef.current?.setSelectionRange(caret, caret);
    });
  };

  const loadInstructionHistory = async (force = false) => {
    if (historyLoading || (historyLoaded && !force)) return;
    historyControllerRef.current?.abort();
    const controller = new AbortController();
    historyControllerRef.current = controller;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const data = await apiGet<{ history: InstructionHistoryItem[] }>(
        "/api/tasks/instruction-history?limit=24",
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setInstructionHistory(data.history);
      setHistoryLoaded(true);
    } catch (error) {
      if (!controller.signal.aborted) {
        setHistoryError(error instanceof Error ? error.message : "读取失败");
      }
    } finally {
      if (historyControllerRef.current === controller) {
        historyControllerRef.current = null;
        setHistoryLoading(false);
      }
    }
  };

  const useHistoryInstruction = (item: InstructionHistoryItem) => {
    updateParam("brief", item.instruction);
    setHistoryOpen(false);
    requestAnimationFrame(() => {
      briefInputRef.current?.focus();
      briefInputRef.current?.setSelectionRange(
        item.instruction.length,
        item.instruction.length,
      );
    });
  };

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setVideos([]);
    setVoiceReferences([]);
    const cachedFeatures = cachedReadyFeatures ?? [];
    const cachedFeature =
      cachedFeatures.find((item) => item.id === initialFeatureId) ??
      cachedFeatures.find((item) => item.id === "omni_video") ??
      cachedFeatures[0] ??
      null;
    setReadyFeatures(cachedFeatures);
    setFeature(cachedFeature);
    setVideoId(initialVideoId ?? "");
    setSecondaryVideoId("");
    setVoiceSource("built_in");
    setParams(cachedFeature ? initialParams(cachedFeature) : {});
    setImages([]);
    setSubmitStatus("");
    setVideoUploadNow(null);
    setVideoDragging(false);
    historyControllerRef.current?.abort();
    setHistoryOpen(false);
    setHistoryLoading(false);
    setHistoryLoaded(false);
    setHistoryError("");
    setInstructionHistory([]);
    (async () => {
      try {
        const [videoData, featureData, voiceData] = await Promise.all([
          apiGet<{ videos: VideoOut[]; voiceReferences?: VideoOut[] }>("/api/videos?includeVoiceReferences=1", {
            signal: controller.signal,
          }),
          apiGet<{ features: FeatureMeta[] }>("/api/features", {
            signal: controller.signal,
          }),
          apiGet<{ voices: { id: string; name: string; status: string }[] }>("/api/voices?libraryOnly=1", { signal: controller.signal }).catch(() => ({ voices: [] })),
        ]);
        const availableFeatures = featureData.features.filter(
          (item) =>
            item.status === "ready" &&
            (item.id === "omni_video" || item.id === "auto_edit" || item.id === "watermark_removal"),
        );
        const selectedFeature =
          availableFeatures.find((item) => item.id === initialFeatureId) ??
          availableFeatures.find((item) => item.id === "omni_video") ??
          availableFeatures[0];
        if (!selectedFeature) throw new Error("创作入口暂不可用");
        cachedReadyFeatures = availableFeatures;
        if (controller.signal.aborted) return;
        setVideos(videoData.videos);
        setVoiceReferences(videoData.voiceReferences ?? []);
        setPersonalVoices(voiceData.voices.filter(v => v.status === "ready"));
        setReadyFeatures(availableFeatures);
        setFeature(selectedFeature);
        setParams(initialParams(selectedFeature));
      } catch (error) {
        if (!controller.signal.aborted) {
          toast.error(error instanceof Error ? error.message : "加载失败");
        }
      }
    })();
    return () => {
      controller.abort();
      historyControllerRef.current?.abort();
      videoUploadControllerRef.current?.abort();
    };
  }, [open, initialFeatureId, initialVideoId, setVideoUploadNow]);

  const uploadReferenceVideo = async (
    file: File,
    slot: "primary" | "secondary" | "voice" = "primary",
  ) => {
    if (busy) return;
    const controller = new AbortController();
    videoUploadControllerRef.current = controller;
    setVideoUploadNow({
      name: file.name,
      percent: 0,
      phase: "uploading",
      bytesPerSecond: 0,
      slot,
    });
    const thumbnailPromise = slot === "voice" ? Promise.resolve(null) : generateVideoThumbnail(file);
    try {
      const uploadedVideo = await uploadVideoFile(
        file,
        (progress) =>
          updateVideoUpload({
            name: file.name,
            percent: progress.percent,
            phase: progress.phase,
            bytesPerSecond: progress.bytesPerSecond,
            statusText: progress.statusText,
            slot,
          }, progress.phase === "saving" || Boolean(progress.statusText)),
        controller.signal,
        slot === "voice" ? "voice_reference" : "video",
      );
      if (uploadedVideo.mimeType.startsWith("audio/")) {
        setVoiceReferences((current) => [
          uploadedVideo,
          ...current.filter((media) => media.id !== uploadedVideo.id),
        ]);
      } else {
        setVideos((current) => [
          uploadedVideo,
          ...current.filter((video) => video.id !== uploadedVideo.id),
        ]);
      }
      if (slot === "voice") {
        updateParam("voiceReferenceVideoId", uploadedVideo.id);
        setVoiceSource("uploaded");
        toast.success("克隆音源已添加");
      } else if (slot === "secondary") {
        setSecondaryVideoId(uploadedVideo.id);
        toast.success("第二段视频已添加");
      } else {
        setVideoId(uploadedVideo.id);
        setSecondaryVideoId((current) =>
          current === uploadedVideo.id ? "" : current,
        );
        toast.success("主视频已添加");
      }
      void thumbnailPromise.then(async (dataUrl) => {
        if (!dataUrl) return;
        await fetch(`/api/videos/${encodeURIComponent(uploadedVideo.id)}/thumbnail`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataUrl }),
          credentials: "same-origin",
        }).catch(() => undefined);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "视频上传失败";
      const recovery = getVideoUploadRecovery(error);
      if (recovery?.kind === "reconnect") {
        toast.error(message, {
          duration: Number.POSITIVE_INFINITY,
          description: "会在新标签页打开固定入口，当前填写内容仍留在本页。",
          action: {
            label: "重新连接",
            onClick: () =>
              window.open(recovery.url, "_blank", "noopener,noreferrer"),
          },
        });
      } else if (recovery?.kind === "retry") {
        toast.error(message, {
          duration: 20_000,
          action: {
            label: "重试",
            onClick: () => void uploadReferenceVideo(file, slot),
          },
        });
      } else {
        toast.error(message);
      }
    } finally {
      if (videoUploadControllerRef.current === controller) {
        videoUploadControllerRef.current = null;
      }
      setVideoUploadNow(null);
      setVideoDragging(false);
    }
  };

  const submit = async () => {
    if (!feature) {
      toast.error("创作入口还没有准备好");
      return;
    }
    const brief = isAutoEdit
      ? AUTO_EDIT_DEFAULT_BRIEF
      : String(params.brief ?? "").trim();
    if (!brief && !isWatermarkRemoval) {
      toast.error("先告诉我你想做成什么样");
      return;
    }
    if (isMediaTask) {
      if (!videoId) {
        toast.error(isWatermarkRemoval ? "先添加一条要去水印的视频" : "先添加一条要剪辑的视频");
        return;
      }
      if (isAutoEdit && !["en", "es"].includes(String(params.subtitleLanguage ?? "en"))) {
        toast.error("字幕语言无效，请重新选择");
        return;
      }
      if (isAutoEdit && params.editVoice === "narration" && voiceSource === "uploaded" && !params.voiceReferenceVideoId) {
        toast.error("请先上传或选择一个有清晰人声的音频或视频");
        return;
      }
      if (isAutoEdit && params.editVoice === "narration" && voiceSource === "personal" && !params.personalVoiceId) {
        toast.error("请选择已保存的个人音色");
        return;
      }
    } else {
      const duration = Number(params.duration ?? 15);
      if (!Number.isFinite(duration) || duration < 4 || duration > 60) {
        toast.error("时长需要在 4–60 秒之间");
        return;
      }
      if (duration > 15 && params.continuity === "single") {
        toast.error("超过 15 秒时，请选择自动判断或分段续接");
        return;
      }
      if (!videoId && params.referenceDelivery === "video_images_text") {
        toast.error("想拿到参考视频，需要先添加一条视频");
        return;
      }
    }

    const selectedVoiceProfile = normalizePreviewVoice(params.editVoiceProfile, params.editNarrator);
    const taskParams: Record<string, unknown> = isWatermarkRemoval
      ? { watermarkOnly: true }
      : isAutoEdit
      ? {
          ...params,
          ...AUTO_EDIT_DEFAULT_PARAMS,
          editTemplateId: getEditTemplate(params.editTemplateId)?.id ?? DEFAULT_EDIT_TEMPLATE,
          editTemplateVersion: EDIT_TEMPLATE_VERSION,
          editColorStyle: String(params.editColorStyle ?? "original"),
          editVoice: params.editVoice === "narration" ? "narration" : "original",
          editNarrator: previewVoiceGender(selectedVoiceProfile),
          editVoiceProfile: selectedVoiceProfile,
          voiceReferenceVideoId: params.editVoice === "narration" && voiceSource === "uploaded" ? String(params.voiceReferenceVideoId ?? "") : "",
          personalVoiceId: params.editVoice === "narration" && voiceSource === "personal" ? String(params.personalVoiceId ?? "") : "",
          editEmotion: ["excited","emphatic"].includes(String(params.editEmotion)) ? params.editEmotion : "neutral",
          editNarrationDepth: ["brief","full"].includes(String(params.editNarrationDepth)) ? params.editNarrationDepth : "auto",
          editNarrationBrief: String(params.editNarrationBrief ?? "").trim(),
          captionStyle: getEditTemplate(params.editTemplateId)?.captionStyle ?? "punchy",
          subtitleLanguage: String(params.subtitleLanguage ?? "en"),
          secondaryVideoId,
        }
      : { ...params };
    const taskImages = isMediaTask ? [] : images;
    const uploadedAssetIds: string[] = [];
    let taskCreated = false;
    setSubmitting(true);
    try {
      const fieldAssetIds = new Array<string>(taskImages.length);
      let nextIndex = 0;
      let uploadedCount = 0;
      let uploadError: unknown = null;
      const worker = async () => {
        while (true) {
          if (uploadError) return;
          const index = nextIndex;
          nextIndex += 1;
          if (index >= taskImages.length) return;
          const file = taskImages[index].file;
          setSubmitStatus(`正在添加图片 ${uploadedCount + 1}/${taskImages.length}`);
          try {
            const formData = new FormData();
            formData.append("file", file);
            const response = await fetch("/api/assets", {
              method: "POST",
              body: formData,
              credentials: "same-origin",
            });
            const data = (await response.json().catch(() => ({}))) as {
              asset?: { id?: unknown };
              error?: unknown;
            };
            if (!response.ok) {
              throw new Error(typeof data.error === "string" ? data.error : "图片上传失败");
            }
            if (typeof data.asset?.id !== "string" || !data.asset.id) {
              throw new Error("图片上传响应无效");
            }
            fieldAssetIds[index] = data.asset.id;
            uploadedAssetIds.push(data.asset.id);
            uploadedCount += 1;
            setSubmitStatus(`正在添加图片 ${uploadedCount}/${taskImages.length}`);
          } catch (error) {
            uploadError ??= error;
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(3, taskImages.length) }, () => worker()),
      );
      if (uploadError) throw uploadError;
      taskParams.referenceImages = fieldAssetIds;
      taskParams.inputReferenceLabels = JSON.stringify(
        taskImages.map((selected) => inputImageLabel(selected.referenceNumber)),
      );
      setSubmitStatus(isWatermarkRemoval ? "正在加入去水印队列……" : isAutoEdit ? "正在加入剪辑队列……" : "正在创建……");
      await apiSend("/api/tasks", "POST", {
        videoId,
        featureId: feature.id,
        params: taskParams,
      });
      taskCreated = true;
    } catch (error) {
      let cleanupMessage = "";
      if (!taskCreated && uploadedAssetIds.length > 0) {
        const cleanupFailures = await cleanupUploadedAssets(uploadedAssetIds);
        if (cleanupFailures > 0) cleanupMessage = "；部分临时图片未能清理";
      }
      toast.error(`${error instanceof Error ? error.message : "创建失败"}${cleanupMessage}`);
    } finally {
      setSubmitting(false);
      setSubmitStatus("");
    }
    if (taskCreated) {
      toast.success(isWatermarkRemoval ? "已加入去水印队列" : isAutoEdit ? "已加入剪辑队列" : "已经开始理解你的想法");
      onCreated();
      onClose();
    }
  };

  const delivery = String(params.referenceDelivery ?? "images_text");
  const facePolicy = String(params.faceReferencePolicy ?? "faces_allowed");

  const content = <>
        <DialogHeader className="border-b border-zinc-200/80 bg-white px-5 py-5 sm:px-7">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-2xl bg-zinc-950 text-white shadow-lg shadow-indigo-200">
              {isWatermarkRemoval ? (
                <Eraser className="h-4 w-4" />
              ) : isAutoEdit ? (
                <Scissors className="h-4 w-4" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
            </span>
            <div>
              {embedded ? <h1 className="text-xl font-semibold tracking-tight">视频去水印</h1> : <DialogTitle className="text-xl tracking-tight">
                {isWatermarkRemoval ? "智能去水印" : isAutoEdit ? "自动精剪" : "开始创作"}
              </DialogTitle>}
              <p className="mt-0.5 text-xs text-zinc-500">
                {isWatermarkRemoval
                  ? "放入视频，只处理水印，原片内容和声音保持不变。"
                  : isAutoEdit
                  ? "放入视频，选好模板和语言，然后开始。"
                  : "把你有的都放进来，再说想要什么。"}
              </p>
            </div>
          </div>
        </DialogHeader>

        {!isWatermarkRemoval && initialFeatureId !== "watermark_removal" && <div className="border-b border-zinc-200/80 bg-white px-4 py-3 sm:px-6">
          <div
            role="tablist"
            aria-label="选择创作方式"
            className="grid grid-cols-2 gap-1 rounded-2xl bg-zinc-100 p-1"
          >
            {[
              {
                id: "omni_video",
                label: "生成视频方案",
                note: "提示词与参考素材",
                icon: Sparkles,
              },
              {
                id: "auto_edit",
                label: "自动剪成片",
                note: "直接输出可下载视频",
                icon: Scissors,
              },
            ].map((mode) => {
              const available = readyFeatures.some((item) => item.id === mode.id);
              const active = feature?.id === mode.id;
              const Icon = mode.icon;
              return (
                <button
                  key={mode.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  disabled={busy || !available}
                  onClick={() => switchFeature(mode.id)}
                  className={cn(
                    "group flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 text-left transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-45 sm:px-4",
                    active
                      ? "bg-white text-zinc-950 shadow-sm ring-1 ring-black/5"
                      : "text-zinc-500 hover:bg-white/70 hover:text-zinc-900",
                  )}
                >
                  <span
                    className={cn(
                      "grid h-8 w-8 shrink-0 place-items-center rounded-lg",
                      active ? "bg-zinc-950 text-white" : "bg-white text-zinc-500",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{mode.label}</span>
                    <span className="hidden truncate text-[11px] text-zinc-400 sm:block">
                      {mode.note}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>}

        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 p-4 sm:p-6 lg:grid-cols-[1.25fr_.75fr]">
          {!isMediaTask && (
          <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="mirror-brief" className="text-sm font-semibold text-zinc-900">
                你想做成什么样？
              </Label>
              <button
                type="button"
                aria-expanded={historyOpen}
                onClick={() => {
                  const next = !historyOpen;
                  setHistoryOpen(next);
                  if (next) void loadInstructionHistory();
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
                历史输入
              </button>
            </div>
            {historyOpen && (
              <div className="mt-3 overflow-hidden rounded-xl border border-zinc-200 bg-zinc-50/80">
                <div className="flex items-center justify-between border-b border-zinc-200 px-3 py-2">
                  <span className="text-xs font-medium text-zinc-700">最近写过的要求</span>
                  {historyLoaded && instructionHistory.length > 0 && (
                    <button
                      type="button"
                      onClick={() => void loadInstructionHistory(true)}
                      disabled={historyLoading}
                      className="text-[11px] text-zinc-400 hover:text-zinc-700 disabled:opacity-50"
                    >
                      刷新
                    </button>
                  )}
                </div>
                <div className="max-h-56 overflow-y-auto overscroll-contain p-1.5">
                  {historyLoading && !historyLoaded ? (
                    <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-zinc-500">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                      正在读取
                    </div>
                  ) : historyError ? (
                    <div className="px-3 py-5 text-center text-xs text-red-600">
                      <p>{historyError}</p>
                      <button
                        type="button"
                        onClick={() => void loadInstructionHistory(true)}
                        className="mt-2 font-medium underline underline-offset-4"
                      >
                        重新加载
                      </button>
                    </div>
                  ) : instructionHistory.length === 0 ? (
                    <p className="px-3 py-8 text-center text-xs text-zinc-400">还没有历史输入</p>
                  ) : (
                    <div className="space-y-1">
                      {instructionHistory.map((item) => {
                        const status = historyTaskStatus(item.taskStatus);
                        return (
                          <div
                            key={item.id}
                            className="group rounded-lg bg-white px-3 py-2.5 ring-1 ring-zinc-200/70"
                          >
                            <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                              <span>{item.kind === "revision" ? "补充修改" : `任务 #${item.taskId}`}</span>
                              {status && <span>· {status}</span>}
                              <span className="ml-auto">{formatHistoryTime(item.createdAt)}</span>
                            </div>
                            <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap text-xs leading-5 text-zinc-700">
                              {item.instruction}
                            </p>
                            <div className="mt-2 flex justify-end gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  void copyInstruction(item.instruction)
                                    .then(() => toast.success("已复制"))
                                    .catch(() => toast.error("复制失败"));
                                }}
                                className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                              >
                                <Copy className="h-3 w-3" aria-hidden="true" />
                                复制
                              </button>
                              <button
                                type="button"
                                onClick={() => useHistoryInstruction(item)}
                                className="inline-flex h-7 items-center gap-1 rounded-md bg-zinc-900 px-2.5 text-[11px] font-medium text-white hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                              >
                                <PencilLine className="h-3 w-3" aria-hidden="true" />
                                带入修改
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
            <Textarea
              ref={briefInputRef}
              id="mirror-brief"
              name="creative-brief"
              autoComplete="off"
              rows={9}
              maxLength={12000}
              value={String(params.brief ?? "")}
              onChange={(event) => updateParam("brief", event.target.value)}
              placeholder="例如：把这条片里的人和产品换成我的，故事和主要动作保留；或者：借它前三秒的反转，重新做一条我的产品广告……"
              className="mt-3 min-h-48 resize-y border-0 bg-zinc-50 px-4 py-3 text-[15px] leading-7 shadow-inner focus-visible:ring-indigo-500"
            />
            <div className="mt-4">
              <ImagePicker
                files={images}
                onChange={setImages}
                onInsertReference={insertBriefReference}
                disabled={busy}
              />
            </div>
          </section>
          )}

          <section
            className={cn(
              "min-w-0 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5",
              isMediaTask && "lg:col-span-2",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <Label
                htmlFor="reference-video-file"
                className="text-sm font-semibold text-zinc-900"
              >
                {isWatermarkRemoval ? "要去水印的视频" : isAutoEdit ? "要剪的视频" : "参考视频1"}
              </Label>
              <span className="text-[11px] text-zinc-400">
                {isWatermarkRemoval ? "必选 · 1 条" : isAutoEdit ? "主视频必选 · 第二条可选" : "可选 · 1 条"}
              </span>
            </div>
            <input
              ref={videoInputRef}
              id="reference-video-file"
              type="file"
              accept="video/*,.mp4,.mov,.avi,.mkv,.webm,.m4v,.flv,.wmv"
              className="sr-only"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void uploadReferenceVideo(file);
                event.currentTarget.value = "";
              }}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => videoInputRef.current?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                if (!busy) setVideoDragging(true);
              }}
              onDragLeave={() => setVideoDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setVideoDragging(false);
                const file = event.dataTransfer.files?.[0];
                if (file && !busy) void uploadReferenceVideo(file);
              }}
              className={cn(
                "mt-3 flex min-h-32 w-full flex-col items-center justify-center rounded-2xl border border-dashed px-4 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60",
                videoDragging
                  ? "border-indigo-500 bg-indigo-50"
                  : "border-zinc-300 bg-zinc-50 hover:border-indigo-300 hover:bg-indigo-50/40",
              )}
            >
              {videoUpload?.slot === "primary" ? (
                <Loader2 className="h-5 w-5 animate-spin text-indigo-600" />
              ) : (
                <Upload className="h-5 w-5 text-zinc-600" />
              )}
              <span className="mt-2 text-sm font-medium">
                {videoUpload?.slot === "primary"
                  ? videoUpload.phase === "saving"
                    ? "正在保存"
                    : "正在上传"
                  : isWatermarkRemoval
                    ? "上传或拖入要处理的视频"
                    : isAutoEdit
                    ? "上传或拖入主视频"
                    : "上传或拖入参考视频1"}
              </span>
              <span className="mt-1 text-[11px] text-zinc-400">最大 1GB</span>
            </button>
            {videoUpload?.slot === "primary" && (
              <div
                aria-live="polite"
                className="mt-3 space-y-2 rounded-xl border p-3"
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate">{videoUpload.name}</span>
                  <span className="tabular-nums">{videoUpload.percent}%</span>
                </div>
                <Progress
                  value={videoUpload.percent}
                  aria-label={`${videoUpload.name} 上传进度`}
                />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[11px] text-zinc-400">
                    {videoUpload.statusText
                      ? videoUpload.statusText
                      : videoUpload.phase === "saving"
                      ? "文件已传完"
                      : videoUpload.bytesPerSecond > 0
                        ? `${formatFileSize(videoUpload.bytesPerSecond)}/秒`
                        : "正在连接"}
                  </span>
                  {videoUpload.phase === "uploading" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => videoUploadControllerRef.current?.abort()}
                    >
                      取消
                    </Button>
                  )}
                </div>
              </div>
            )}
            <Select
              value={videoId || "__none__"}
              onValueChange={(value) => {
                const next = value === "__none__" ? "" : value;
                setVideoId(next);
                if (next && next === secondaryVideoId) setSecondaryVideoId("");
              }}
              disabled={busy}
            >
              <SelectTrigger
                aria-label="从素材库选择参考视频"
                className="mt-3 min-w-0 w-full [&>span]:truncate"
              >
                <SelectValue placeholder={isWatermarkRemoval ? "从素材库选择视频" : isAutoEdit ? "从素材库选原片" : "从素材库选择"} />
              </SelectTrigger>
              <SelectContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
                <SelectItem value="__none__">
                  {isMediaTask ? "尚未选择视频" : "不使用参考视频"}
                </SelectItem>
                {videos
                  .filter((video) => !isAutoEdit || video.id !== secondaryVideoId)
                  .map((video) => (
                  <SelectItem key={video.id} value={video.id}>
                    <span className="block max-w-[65vw] truncate sm:max-w-sm">{video.name}</span>
                  </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {selectedVideo && (
              <div className="mt-3 flex items-center gap-2 rounded-xl bg-indigo-50 px-3 py-2.5 text-xs text-indigo-950">
                <Film className="h-4 w-4 shrink-0 text-indigo-600" />
                {isWatermarkRemoval ? (
                  <span className="shrink-0 rounded-md bg-white px-2 py-1 font-medium text-indigo-700">
                    原视频
                  </span>
                ) : isAutoEdit ? (
                  <span className="shrink-0 rounded-md bg-white px-2 py-1 font-medium text-indigo-700">
                    主视频
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => insertBriefReference(inputVideoLabel())}
                    className="shrink-0 rounded-md bg-white px-2 py-1 font-medium text-indigo-700 hover:bg-indigo-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    aria-label="把参考视频1写入需求"
                  >
                    参考视频1
                  </button>
                )}
                <span className="min-w-0 flex-1 truncate">{selectedVideo.name}</span>
                <button
                  type="button"
                  aria-label="移除参考视频"
                  onClick={() => setVideoId("")}
                  className="grid h-7 w-7 place-items-center rounded-md text-indigo-400 hover:bg-white hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {isWatermarkRemoval && (
              <div className="mt-4 overflow-hidden rounded-xl border border-indigo-100 bg-gradient-to-r from-indigo-50 via-white to-cyan-50 p-3">
                <div className="h-px w-full bg-gradient-to-r from-transparent via-indigo-400 to-transparent" />
                <p className="mt-2 text-xs leading-5 text-zinc-600">
                  自动区分平台/账号水印与产品品牌、包装和正常字幕；只处理有足够画面证据的安全区域。
                </p>
              </div>
            )}
            {isAutoEdit && (
              <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-medium text-zinc-700">第二条视频</span>
                  <span className="text-[11px] text-zinc-400">可选</span>
                </div>
                <input
                  ref={secondaryVideoInputRef}
                  id="secondary-video-file"
                  type="file"
                  accept="video/*,.mp4,.mov,.avi,.mkv,.webm,.m4v,.flv,.wmv"
                  className="sr-only"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void uploadReferenceVideo(file, "secondary");
                    event.currentTarget.value = "";
                  }}
                />
                <div className="mt-2 grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => secondaryVideoInputRef.current?.click()}
                    className="justify-center"
                  >
                    {videoUpload?.slot === "secondary" ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="mr-2 h-4 w-4" />
                    )}
                    {videoUpload?.slot === "secondary" ? "正在上传" : "上传第二条"}
                  </Button>
                  <Select
                    value={secondaryVideoId || "__none__"}
                    onValueChange={(value) =>
                      setSecondaryVideoId(value === "__none__" ? "" : value)
                    }
                    disabled={busy}
                  >
                    <SelectTrigger
                      aria-label="从素材库选择第二段视频"
                      className="min-w-0 w-full [&>span]:truncate"
                    >
                      <SelectValue placeholder="从素材库选择第二条" />
                    </SelectTrigger>
                    <SelectContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
                      <SelectItem value="__none__">不使用第二条视频</SelectItem>
                      {videos
                        .filter((video) => video.id !== videoId)
                        .map((video) => (
                          <SelectItem key={video.id} value={video.id}>
                            <span className="block max-w-[65vw] truncate sm:max-w-sm">
                              {video.name}
                            </span>
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                {videoUpload?.slot === "secondary" && (
                  <div aria-live="polite" className="mt-2 space-y-2 rounded-lg bg-white p-3">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate">{videoUpload.name}</span>
                      <span className="tabular-nums">{videoUpload.percent}%</span>
                    </div>
                    <Progress
                      value={videoUpload.percent}
                      aria-label={`${videoUpload.name} 上传进度`}
                    />
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[11px] text-zinc-400">
                        {videoUpload.statusText
                          ? videoUpload.statusText
                          : videoUpload.phase === "saving"
                            ? "文件已传完"
                            : videoUpload.bytesPerSecond > 0
                              ? `${formatFileSize(videoUpload.bytesPerSecond)}/秒`
                              : "正在连接"}
                      </span>
                      {videoUpload.phase === "uploading" && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => videoUploadControllerRef.current?.abort()}
                        >
                          取消
                        </Button>
                      )}
                    </div>
                  </div>
                )}
                {selectedSecondaryVideo && (
                  <div className="mt-2 flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-xs text-zinc-700">
                    <Film className="h-4 w-4 shrink-0 text-indigo-600" />
                    <span className="shrink-0 rounded-md bg-indigo-50 px-2 py-1 font-medium text-indigo-700">
                      第二条
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {selectedSecondaryVideo.name}
                    </span>
                    <button
                      type="button"
                      aria-label="移除第二段视频"
                      onClick={() => setSecondaryVideoId("")}
                      className="grid h-7 w-7 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            )}
            {isAutoEdit && (
              <EditTemplatePicker templateId={String(params.editTemplateId ?? DEFAULT_EDIT_TEMPLATE)}
                colorStyle={String(params.editColorStyle ?? "original")} onColorStyle={(value)=>updateParam("editColorStyle",value)}
                language={params.subtitleLanguage === "es" ? "es" : "en"} disabled={busy}
                narration={params.editVoice === "narration"} narrator={normalizePreviewVoice(params.editVoiceProfile, params.editNarrator)}
                usingUploadedVoice={params.editVoice === "narration" && voiceSource !== "built_in"}
                depth={params.editNarrationDepth === "brief" ? "brief" : params.editNarrationDepth === "full" ? "full" : "auto"}
                onDepth={(depth)=>updateParam("editNarrationDepth",depth)}
                narrationBrief={String(params.editNarrationBrief ?? "")} onNarrationBrief={(value)=>updateParam("editNarrationBrief",value)}
                emotion={params.editEmotion === "excited" ? "excited" : params.editEmotion === "emphatic" ? "emphatic" : "neutral"}
                onNarration={(enabled)=>updateParam("editVoice",enabled ? "narration" : "original")}
                onNarrator={(voice)=>setParams((previous)=>({...previous,editVoiceProfile:voice,editNarrator:previewVoiceGender(voice)}))} onEmotion={(emotion)=>updateParam("editEmotion",emotion)}
                onTemplate={(id) => updateParam("editTemplateId", id)}
                onLanguage={(language) => updateParam("subtitleLanguage", language)} />
            )}
            {isAutoEdit && params.editVoice === "narration" && (
              <div className="mt-4 min-w-0 rounded-xl border border-zinc-200 bg-white p-4">
                <p className="text-sm font-semibold text-zinc-900">画外解说用谁的声音</p>
                <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label="画外解说音源">
                  {([{id:"built_in",label:"内置男声 / 女声"},{id:"personal",label:"我的音色"},{id:"uploaded",label:"临时上传音源"}] as const).map(item=>(
                    <label key={item.id} className="cursor-pointer">
                      <input type="radio" name="edit-voice-source" className="peer sr-only" checked={voiceSource===item.id} disabled={busy} onChange={()=>{
                        setVoiceSource(item.id);
                        if(item.id!=="uploaded") updateParam("voiceReferenceVideoId","");
                        if(item.id!=="personal") updateParam("personalVoiceId","");
                      }}/>
                      <span className="block rounded-lg border border-zinc-200 px-3 py-2 text-xs text-zinc-700 peer-checked:border-indigo-500 peer-checked:bg-indigo-50 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-500">{item.label}</span>
                    </label>
                  ))}
                </div>
                {voiceSource === "personal" && <div className="mt-3 space-y-2">
                  <Select value={String(params.personalVoiceId || "__none__")} onValueChange={value => updateParam("personalVoiceId", value === "__none__" ? "" : value)} disabled={busy}>
                    <SelectTrigger aria-label="选择我的克隆音色"><SelectValue placeholder="选择保存的音色" /></SelectTrigger>
                    <SelectContent><SelectItem value="__none__">请选择个人音色</SelectItem>{personalVoices.map(v => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}</SelectContent>
                  </Select>
                  <p className="text-xs leading-5 text-zinc-500">准备好的个人音色直接复用，无需重复上传。<a href="/voices" target="_blank" rel="noreferrer" className="text-indigo-600 underline">管理或添加音色</a>，完成后重新打开创作窗口即可选择。</p>
                </div>}
                {voiceSource === "uploaded" && <div className="mt-3 space-y-2">
                  <p className="text-xs leading-5 text-zinc-600">可上传纯音频或视频；系统只提取其中的人声作为新增解说的音色，不把视频画面剪进成片，也不替换原片人物说话。请使用你有权使用、单人清晰说话的声音。</p>
                  <input ref={voiceVideoInputRef} type="file" accept="audio/*,video/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.wma,.aiff,.aif,.caf,.mp4,.mov,.avi,.mkv,.webm,.m4v" className="sr-only" disabled={busy} onChange={(event)=>{
                    const file=event.target.files?.[0];
                    if(file) void uploadReferenceVideo(file,"voice");
                    event.currentTarget.value="";
                  }}/>
                  <div className="grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
                    <Button type="button" variant="outline" disabled={busy} onClick={()=>voiceVideoInputRef.current?.click()}>
                      {videoUpload?.slot==="voice" ? <Loader2 className="mr-2 h-4 w-4 animate-spin"/> : <Upload className="mr-2 h-4 w-4"/>}
                      {videoUpload?.slot==="voice" ? "正在上传" : "上传音频 / 视频"}
                    </Button>
                    <Select value={String(params.voiceReferenceVideoId || "__none__")} onValueChange={(value)=>updateParam("voiceReferenceVideoId",value==="__none__"?"":value)} disabled={busy}>
                      <SelectTrigger aria-label="从素材库选择克隆音源" className="min-w-0 w-full [&>span]:truncate"><SelectValue placeholder="或从素材库选择"/></SelectTrigger>
                      <SelectContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
                        <SelectItem value="__none__">选择有清晰人声的音频或视频</SelectItem>
                        {selectableVoiceReferences.map(media=><SelectItem key={media.id} value={media.id}><span className="block max-w-[65vw] truncate sm:max-w-sm">{media.mimeType.startsWith("audio/") ? "音频 · " : "视频 · "}{media.name}</span></SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  {videoUpload?.slot==="voice" && <div role="status" className="rounded-lg border border-zinc-200 p-3 text-xs">
                    <div className="flex justify-between gap-2"><span className="min-w-0 truncate">{videoUpload.name}</span><span>{videoUpload.percent}%</span></div>
                    <Progress value={videoUpload.percent} aria-label="克隆音源上传进度" className="mt-2"/>
                    <div className="mt-2 flex items-center justify-between"><span className="text-zinc-500">{videoUpload.statusText || (videoUpload.phase==="saving"?"文件已传完":videoUpload.bytesPerSecond>0?`${formatFileSize(videoUpload.bytesPerSecond)}/秒`:"正在连接")}</span>{videoUpload.phase==="uploading"&&<Button type="button" variant="ghost" size="sm" onClick={()=>videoUploadControllerRef.current?.abort()}>取消</Button>}</div>
                  </div>}
                  {selectedVoiceVideo && <p className="max-w-full truncate rounded-lg bg-indigo-50 px-3 py-2 text-xs text-indigo-800">已选音源：{selectedVoiceVideo.name}</p>}
                  <p className="text-[11px] leading-5 text-zinc-500">不同视频的背景音乐、叠音和录音质量会影响相似度；有可安全插入的解说空隙才会配入。</p>
                </div>}
              </div>
            )}
          </section>

          {!isMediaTask && (
            <section className="space-y-5 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm sm:p-5 lg:col-span-2">
              <div>
                <Label className="text-sm font-semibold">你要拿走什么</Label>
                <div className="mt-2">
                  <ChoiceCards
                    value={delivery}
                    onChange={(value) => updateParam("referenceDelivery", value)}
                    columns={3}
                    options={[
                      { value: "text_only", label: "只要提示词" },
                      { value: "images_text", label: "图片 + 提示词" },
                      {
                        value: "video_images_text",
                        label: "图片 + 视频 + 提示词",
                        note: videoId ? undefined : "需要先添加参考视频",
                      },
                    ]}
                  />
                </div>
              </div>
              <div className="grid gap-5 lg:grid-cols-2">
                <div>
                  <Label className="text-sm font-semibold">交付素材能否露脸</Label>
                  <div className="mt-2">
                    <ChoiceCards
                      value={facePolicy}
                      onChange={(value) => updateParam("faceReferencePolicy", value)}
                      options={[
                        { value: "faces_allowed", label: "可以露脸", note: "需要时可生成正常人物参考图" },
                        { value: "no_faces", label: "不能露脸", note: "改用文字、无脸图片或动作参考" },
                      ]}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="mirror-duration" className="text-xs text-zinc-500">时长</Label>
                    <div className="relative mt-1.5">
                      <Input
                        id="mirror-duration"
                        name="duration"
                        type="number"
                        min={4}
                        max={60}
                        value={String(params.duration ?? 15)}
                        onChange={(event) => updateParam("duration", Number(event.target.value))}
                        className="pr-8"
                      />
                      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-zinc-400">秒</span>
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs text-zinc-500">续接</Label>
                    <Select value={String(params.continuity ?? "auto")} onValueChange={(value) => updateParam("continuity", value)}>
                      <SelectTrigger aria-label="续接方式" className="mt-1.5"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">自动判断</SelectItem>
                        <SelectItem value="single">一次生成</SelectItem>
                        <SelectItem value="stitch">分段续接</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs text-zinc-500">视频模型</Label>
                    <Select value={String(params.targetModel ?? "seedance")} onValueChange={(value) => updateParam("targetModel", value)}>
                      <SelectTrigger aria-label="视频模型" className="mt-1.5"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="seedance">即梦 / Seedance</SelectItem>
                        <SelectItem value="auto">自动适配</SelectItem>
                        <SelectItem value="kling">可灵</SelectItem>
                        <SelectItem value="veo">Veo</SelectItem>
                        <SelectItem value="other">其他</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs text-zinc-500">声音</Label>
                    <Select value={String(params.sound ?? "generate")} onValueChange={(value) => updateParam("sound", value)}>
                      <SelectTrigger aria-label="声音" className="mt-1.5"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="generate">生成声音</SelectItem>
                        <SelectItem value="reference_rhythm">参考原片节奏</SelectItem>
                        <SelectItem value="mute">无声</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>

        {submitStatus && (
          <div aria-live="polite" className="mx-4 mb-3 flex items-center gap-2 rounded-xl border bg-white px-3 py-2 text-xs text-zinc-500 sm:mx-6">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span>{submitStatus}</span>
          </div>
        )}
        <DialogFooter className="border-t border-zinc-200 bg-white px-5 py-4 sm:px-7">
          {!embedded && <Button variant="ghost" onClick={onClose} disabled={busy}>取消</Button>}
          <Button
            size="lg"
            onClick={() => void submit()}
            disabled={busy || !feature}
            className="min-w-32 bg-zinc-950 shadow-lg shadow-zinc-200 hover:bg-zinc-800"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isWatermarkRemoval ? (
              <Eraser className="h-4 w-4" />
            ) : isAutoEdit ? (
              <Scissors className="h-4 w-4" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            {submitting
              ? isWatermarkRemoval
                ? "正在加入"
                : isAutoEdit
                  ? "正在加入"
                : "正在创建"
              : isWatermarkRemoval
                ? "开始去水印"
                : isAutoEdit
                  ? "开始剪辑"
                : "先看看理解"}
          </Button>
        </DialogFooter>
    </>;
  if (embedded) return <section aria-busy={busy} className="overflow-hidden rounded-2xl border bg-[#f7f7f9]">{content}</section>;
  return <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
    <DialogContent aria-describedby={undefined} aria-busy={busy} className={cn(
      "max-h-[94dvh] w-[calc(100vw-1rem)] overflow-x-hidden overflow-y-auto overscroll-contain border-0 bg-[#f7f7f9] p-0 shadow-2xl sm:w-full",
      isMediaTask ? "max-w-3xl" : "max-w-4xl",
    )}>{content}</DialogContent>
  </Dialog>;
}

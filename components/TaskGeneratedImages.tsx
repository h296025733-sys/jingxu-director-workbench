"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Download,
  ImagePlus,
  Loader2,
  Paperclip,
  RefreshCw,
  Square,
  Video,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiGet, apiSend } from "@/lib/client";
import type {
  GeneratedImageOut,
  ReferencePreparationOut,
} from "@/lib/types";
import { toast } from "sonner";
import { downloadAttachment } from "@/lib/download-client";

export interface GeneratedImageRequirement {
  kind: string;
  status: "provided" | "missing" | "not_applicable" | "unknown";
  assetKey: string;
  reason: string;
  canGenerate: boolean;
  dependsOnAssetKeys: string[];
}

export interface GeneratedImageUploadPlanItem {
  order: number;
  reference: string;
  assetKey: string;
  displayName: string;
  type: string;
  coreResponsibility: string;
  doNotReference: string;
  timeRange: string;
}

export interface ProvidedTaskAsset {
  assetKey: string;
  name: string;
  type: string;
  url: string;
}

function byNewest(a: GeneratedImageOut, b: GeneratedImageOut): number {
  return b.version - a.version;
}

function imageState(image: GeneratedImageOut | undefined): {
  label: string;
  variant: "outline" | "secondary" | "destructive" | "default";
} {
  if (!image) return { label: "等待生成", variant: "outline" };
  if (image.status === "pending") return { label: "排队中", variant: "outline" };
  if (image.status === "running") return { label: "正在生成", variant: "secondary" };
  if (image.status === "failed") return { label: "需要重做", variant: "destructive" };
  if (image.adopted) return { label: "可上传", variant: "default" };
  return { label: "请确认", variant: "secondary" };
}

function friendlyRequirementName(kind: string): string {
  if (/expression|表情/i.test(kind)) return "表情参考图";
  if (/character|person|identity|人物|角色|身份/i.test(kind)) return "人物参考图";
  if (/scene|background|environment|场景|背景|环境/i.test(kind)) return "场景参考图";
  if (/product|packag|产品|包装/i.test(kind)) return "产品参考图";
  if (/style|风格|画风/i.test(kind)) return "风格参考图";
  if (/storyboard|shot|分镜/i.test(kind)) return "分镜参考图";
  if (/action|pose|动作|姿势/i.test(kind)) return "动作参考图";
  return "参考图片";
}

function missingRequirementsNeeded(
  requirements: GeneratedImageRequirement[],
  uploadPlan: GeneratedImageUploadPlanItem[],
): boolean {
  const plannedKeys = new Set(uploadPlan.map((item) => item.assetKey));
  return requirements.some(
    (item) =>
      item.status === "missing" &&
      Boolean(item.assetKey) &&
      (item.canGenerate || plannedKeys.has(item.assetKey)),
  );
}

export default function TaskGeneratedImages({
  taskId,
  active,
  canManage,
  requirements,
  uploadPlan,
  providedAssets = [],
  faceReferencePolicy = "no_faces",
}: {
  taskId: number;
  active: boolean;
  canManage: boolean;
  requirements: GeneratedImageRequirement[];
  uploadPlan: GeneratedImageUploadPlanItem[];
  providedAssets?: ProvidedTaskAsset[];
  faceReferencePolicy?: "faces_allowed" | "no_faces";
}) {
  const [images, setImages] = useState<GeneratedImageOut[]>([]);
  const [preparations, setPreparations] = useState<ReferencePreparationOut[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const requestState = useRef<{
    taskId: number;
    controller: AbortController;
  } | null>(null);
  const needsImageEndpoint = missingRequirementsNeeded(requirements, uploadPlan);
  const needsVideoEndpoint =
    faceReferencePolicy === "no_faces" &&
    uploadPlan.some(
      (item) => item.assetKey === "REFERENCE_VIDEO" && item.type === "video",
    );

  const load = useCallback(
    async (showSpinner = false) => {
      if (!active) return;
      if (!showSpinner && document.visibilityState !== "visible") return;
      if (requestState.current?.taskId === taskId) return;
      requestState.current?.controller.abort();
      const controller = new AbortController();
      requestState.current = { taskId, controller };
      if (showSpinner) setLoading(true);
      try {
        const [imageData, videoData] = await Promise.all([
          needsImageEndpoint
            ? apiGet<{ images: GeneratedImageOut[] }>(
                `/api/tasks/${taskId}/generated-images`,
                { signal: controller.signal },
              )
            : Promise.resolve({ images: [] as GeneratedImageOut[] }),
          needsVideoEndpoint
            ? apiGet<{ preparations: ReferencePreparationOut[] }>(
                `/api/tasks/${taskId}/reference-preparations`,
                { signal: controller.signal },
              )
            : Promise.resolve({ preparations: [] as ReferencePreparationOut[] }),
        ]);
        setImages((current) =>
          JSON.stringify(current) === JSON.stringify(imageData.images)
            ? current
            : imageData.images,
        );
        setPreparations((current) =>
          JSON.stringify(current) === JSON.stringify(videoData.preparations)
            ? current
            : videoData.preparations,
        );
      } catch (error) {
        if (showSpinner && !controller.signal.aborted) {
          toast.error(error instanceof Error ? error.message : "附件加载失败");
        }
      } finally {
        if (requestState.current?.controller === controller) {
          requestState.current = null;
        }
        if (showSpinner) setLoading(false);
      }
    },
    [active, needsImageEndpoint, needsVideoEndpoint, taskId],
  );

  useEffect(() => {
    setImages([]);
    setPreparations([]);
    if (!active) return;
    void load(true);
    return () => {
      requestState.current?.controller.abort();
      requestState.current = null;
    };
  }, [active, load, taskId]);

  const hasActiveGeneration =
    images.some((image) => image.status === "pending" || image.status === "running") ||
    preparations.some(
      (item) => item.status === "pending" || item.status === "running",
    );
  useEffect(() => {
    if (!active || !hasActiveGeneration) return;
    const timer = window.setInterval(() => void load(false), 3500);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load(false);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active, hasActiveGeneration, load]);

  const grouped = useMemo(() => {
    const map = new Map<string, GeneratedImageOut[]>();
    for (const image of images) {
      const list = map.get(image.assetKey) ?? [];
      list.push(image);
      map.set(image.assetKey, list);
    }
    for (const list of map.values()) list.sort(byNewest);
    return map;
  }, [images]);
  const adoptedByKey = useMemo(
    () =>
      new Map(
        images
          .filter((image) => image.adopted && image.status === "succeeded")
          .map((image) => [image.assetKey, image]),
      ),
    [images],
  );
  const providedByKey = useMemo(
    () => new Map(providedAssets.map((asset) => [asset.assetKey, asset])),
    [providedAssets],
  );
  const requirementByKey = useMemo(
    () => new Map(requirements.map((item) => [item.assetKey, item])),
    [requirements],
  );
  const adoptedPreparation = preparations.find(
    (item) => item.adopted && item.status === "succeeded" && item.videoUrl,
  );
  const latestPreparation = preparations[0];
  const shownPreparation =
    latestPreparation?.status === "succeeded" &&
    latestPreparation.id !== adoptedPreparation?.id
      ? latestPreparation
      : adoptedPreparation ?? latestPreparation;
  const requiresReferenceVideo = uploadPlan.some(
    (item) => item.assetKey === "REFERENCE_VIDEO" && item.type === "video",
  );
  const plannedKeys = useMemo(
    () => new Set(uploadPlan.map((item) => item.assetKey)),
    [uploadPlan],
  );
  const plannedProvidedAssets = useMemo(
    () =>
      providedAssets.filter(
        (asset) => asset.type === "image" && plannedKeys.has(asset.assetKey),
      ),
    [plannedKeys, providedAssets],
  );
  const missingRequirements = requirements.filter(
    (requirement) =>
      requirement.status === "missing" &&
      requirement.assetKey &&
      (requirement.canGenerate || plannedKeys.has(requirement.assetKey)),
  );

  const generate = async (assetKey: string) => {
    setActionKey(`generate:${assetKey}`);
    try {
      await apiSend(`/api/tasks/${taskId}/generated-images`, "POST", { assetKey });
      toast.success("正在生成新图片");
      await load(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图片生成失败");
    } finally {
      setActionKey(null);
    }
  };

  const adopt = async (image: GeneratedImageOut) => {
    setActionKey(`adopt:${image.id}`);
    try {
      await apiSend(
        `/api/tasks/${taskId}/generated-images/${encodeURIComponent(image.id)}/adopt`,
        "POST",
      );
      toast.success("已选用这张图片");
      await load(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "选择图片失败");
    } finally {
      setActionKey(null);
    }
  };

  const prepareReferenceVideo = async () => {
    setActionKey("prepare-video");
    try {
      await apiSend(`/api/tasks/${taskId}/reference-preparations`, "POST");
      toast.success("正在准备动作参考视频");
      await load(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "视频处理失败");
    } finally {
      setActionKey(null);
    }
  };

  const cancelPreparation = async (preparation: ReferencePreparationOut) => {
    setActionKey(`cancel-video:${preparation.id}`);
    try {
      await apiSend(
        `/api/tasks/${taskId}/reference-preparations/${encodeURIComponent(preparation.id)}/cancel`,
        "POST",
      );
      toast.success("已取消视频处理");
      await load(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "取消失败");
    } finally {
      setActionKey(null);
    }
  };

  const cancelImage = async (image: GeneratedImageOut) => {
    setActionKey(`cancel:${image.id}`);
    try {
      await apiSend(
        `/api/tasks/${taskId}/generated-images/${encodeURIComponent(image.id)}/cancel`,
        "POST",
      );
      toast.success("已取消图片生成");
      await load(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "取消失败");
    } finally {
      setActionKey(null);
    }
  };

  const adoptPreparation = async (preparation: ReferencePreparationOut) => {
    setActionKey(`adopt-video:${preparation.id}`);
    try {
      await apiSend(
        `/api/tasks/${taskId}/reference-preparations/${encodeURIComponent(preparation.id)}/adopt`,
        "POST",
      );
      toast.success("已选用这个视频");
      await load(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "选择视频失败");
    } finally {
      setActionKey(null);
    }
  };

  const download = async (url: string, fileName: string) => {
    try {
      const mode = await downloadAttachment(url, fileName);
      toast.success(mode === "folder" ? "已保存到你的下载文件夹" : "已交给浏览器下载");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "下载失败");
    }
  };

  if (
    uploadPlan.length === 0 &&
    missingRequirements.length === 0 &&
    images.length === 0 &&
    !requiresReferenceVideo &&
    plannedProvidedAssets.length === 0
  ) {
    return null;
  }

  const videoBusy =
    latestPreparation?.status === "pending" || latestPreparation?.status === "running";
  const videoCanAdopt =
    shownPreparation?.canAdopt === true;
  const videoLabel = adoptedPreparation && videoBusy
    ? "新版准备中"
    : adoptedPreparation
    ? "可上传"
    : videoBusy
      ? "正在准备"
      : latestPreparation?.status === "succeeded"
        ? "请播放确认"
        : latestPreparation
          ? "需要重做"
          : "等待准备";
  const videoVariant = adoptedPreparation && videoBusy
    ? ("secondary" as const)
    : adoptedPreparation
    ? ("default" as const)
    : latestPreparation &&
        (latestPreparation.status === "failed" ||
          latestPreparation.status === "needs_review")
      ? ("destructive" as const)
      : ("secondary" as const);

  return (
    <section aria-busy={loading || hasActiveGeneration}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Paperclip className="h-4 w-4" />
            附件
          </h3>
        </div>
        {loading && (
          <Loader2
            aria-hidden="true"
            className="h-4 w-4 animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        )}
      </div>

      <div className="mt-3 space-y-3">
        {requiresReferenceVideo && faceReferencePolicy === "no_faces" && (
          <div className="overflow-hidden rounded-xl border bg-background">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/20 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-sky-100 text-sky-700">
                  <Video className="h-4 w-4" />
                </span>
                <p className="text-sm font-medium">动作参考视频</p>
              </div>
              <Badge variant={videoVariant}>{videoLabel}</Badge>
            </div>

            {shownPreparation?.videoUrl ? (
              <div className="p-3">
                <video
                  src={shownPreparation.videoUrl}
                  controls
                  preload="metadata"
                  playsInline
                  className="max-h-[30rem] w-full rounded-lg bg-black"
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      !videoCanAdopt ||
                      shownPreparation.adopted ||
                      !canManage ||
                      actionKey !== null
                    }
                    onClick={() => void adoptPreparation(shownPreparation)}
                  >
                    {actionKey === `adopt-video:${shownPreparation.id}` ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                    {shownPreparation.adopted ? "已选用" : "用这个视频"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void download(shownPreparation.videoUrl!, `任务-${taskId}-动作参考视频.mp4`)}
                  >
                    <Download className="h-3.5 w-3.5" />
                    下载
                  </Button>
                  {canManage && videoBusy && latestPreparation ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={actionKey !== null}
                      onClick={() => void cancelPreparation(latestPreparation)}
                    >
                      <Square className="h-3.5 w-3.5" />
                      取消
                    </Button>
                  ) : canManage ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={videoBusy || actionKey !== null}
                      onClick={() => void prepareReferenceVideo()}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      重做
                    </Button>
                  ) : null}
                </div>
                {!videoCanAdopt && !videoBusy && !shownPreparation.adopted && (
                  <p className="mt-2 text-xs text-red-600">
                    这版没有处理好，请点“重做”。
                  </p>
                )}
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3 p-4">
                <p className="text-xs text-muted-foreground">
                  {videoBusy ? "系统正在准备视频，请稍等。" : "还没有可用的视频附件。"}
                </p>
                {canManage && videoBusy && latestPreparation ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={actionKey !== null}
                    onClick={() => void cancelPreparation(latestPreparation)}
                  >
                    <Square className="h-3.5 w-3.5" />
                    取消
                  </Button>
                ) : canManage ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={actionKey !== null}
                    onClick={() => void prepareReferenceVideo()}
                  >
                    <Video className="h-3.5 w-3.5" />
                    准备视频
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        )}

        {missingRequirements.map((requirement) => {
          const candidates = grouped.get(requirement.assetKey) ?? [];
          const adopted = adoptedByKey.get(requirement.assetKey);
          const latest = candidates[0];
          const shown =
            latest?.status === "succeeded" && latest.id !== adopted?.id
              ? latest
              : adopted ?? latest;
          const generating =
            latest?.status === "pending" || latest?.status === "running";
          const state = generating
            ? { label: adopted ? "新版生成中" : "正在生成", variant: "secondary" as const }
            : imageState(shown);
          const displayName =
            uploadPlan.find((item) => item.assetKey === requirement.assetKey)
              ?.displayName || friendlyRequirementName(requirement.kind);
          return (
            <div
              key={requirement.assetKey}
              className="overflow-hidden rounded-xl border bg-background"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/20 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-violet-100 text-violet-700">
                    <ImagePlus className="h-4 w-4" />
                  </span>
                  <p className="text-sm font-medium">{displayName}</p>
                </div>
                <Badge variant={requirement.canGenerate ? state.variant : "destructive"}>
                  {requirement.canGenerate ? state.label : "需要你上传"}
                </Badge>
              </div>

              {!requirement.canGenerate ? (
                <div className="p-4 text-sm text-amber-800">
                  这个素材不能凭空生成。请重新新建任务，并在“补充图片”中上传原图。
                </div>
              ) : shown?.url ? (
                <div className="p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={shown.url}
                    alt={displayName}
                    width={shown.width ?? 1200}
                    height={shown.height ?? 1200}
                    loading="lazy"
                    decoding="async"
                    className="max-h-[30rem] w-full rounded-lg bg-zinc-100 object-contain"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        shown.status !== "succeeded" ||
                        shown.adopted ||
                        !canManage ||
                        actionKey !== null
                      }
                      onClick={() => void adopt(shown)}
                    >
                      {actionKey === `adopt:${shown.id}` ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      {shown.adopted ? "已选用" : "用这张"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void download(shown.url!, `${displayName}-v${shown.version}.png`)}
                    >
                      <Download className="h-3.5 w-3.5" />
                      下载
                    </Button>
                    {canManage && generating && latest ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={actionKey !== null}
                        onClick={() => void cancelImage(latest)}
                      >
                        <Square className="h-3.5 w-3.5" />
                        取消
                      </Button>
                    ) : canManage ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={generating || actionKey !== null}
                        onClick={() => void generate(requirement.assetKey)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        换一张
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3 p-4">
                  <p className="text-xs text-muted-foreground">
                    {generating ? "系统正在生成图片，请稍等。" : "还没有可用的图片附件。"}
                  </p>
                  {canManage && generating && latest ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={actionKey !== null}
                      onClick={() => void cancelImage(latest)}
                    >
                      <Square className="h-3.5 w-3.5" />
                      取消
                    </Button>
                  ) : canManage ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={actionKey !== null}
                      onClick={() => void generate(requirement.assetKey)}
                    >
                      <ImagePlus className="h-3.5 w-3.5" />
                      生成图片
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}

        {plannedProvidedAssets.length > 0 && (
          <div className="rounded-xl border bg-background p-4">
            <p className="text-sm font-medium">你上传的图片</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {plannedProvidedAssets.map((asset) => (
                <Button
                  key={asset.assetKey}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void download(asset.url, asset.name)}
                >
                  <Download className="h-3.5 w-3.5" />
                  <span className="max-w-48 truncate">{asset.name}</span>
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>

      {uploadPlan.length > 0 && (
        <div className="mt-4 rounded-xl border bg-muted/15 p-4">
          <p className="text-sm font-medium">上传顺序</p>
          <div className="mt-3 space-y-2">
            {uploadPlan.map((item, index) => {
              const requirement = requirementByKey.get(item.assetKey);
              const adopted = adoptedByKey.get(item.assetKey);
              const provided = providedByKey.get(item.assetKey);
              const isVideo = item.assetKey === "REFERENCE_VIDEO" && item.type === "video";
              const url = isVideo
                ? faceReferencePolicy === "no_faces"
                  ? adoptedPreparation?.videoUrl
                  : provided?.url
                : adopted?.url ?? provided?.url;
              let state = "已准备";
              if (
                isVideo &&
                faceReferencePolicy === "no_faces" &&
                !adoptedPreparation
              ) {
                state = "等待确认";
              }
              if (requirement?.status === "missing" && !adopted) {
                state = requirement.canGenerate ? "等待确认" : "需要上传";
              }
              return (
                <div
                  key={`${item.order}-${item.assetKey}-${index}`}
                  className="flex flex-col gap-2 rounded-lg bg-background px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-zinc-900 text-xs font-semibold text-white">
                      {item.order || index + 1}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {item.reference} · {item.displayName}
                      </p>
                      <p className="text-[11px] text-muted-foreground">{state}</p>
                    </div>
                  </div>
                  {url && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void download(
                          url,
                          isVideo
                            ? `任务-${taskId}-${item.displayName}.mp4`
                            : `${item.displayName}.png`,
                        )
                      }
                    >
                      <Download className="h-3.5 w-3.5" />
                      下载
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

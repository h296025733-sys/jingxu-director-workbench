import "server-only";

import fs from "node:fs";
import path from "node:path";
import type { FeatureContext, FeatureResult } from "@/features/base";
import type {
  CodexDirectorOutput,
  DirectorInputAsset,
  DirectorSkillName,
} from "./codex-director";
import { prepareVideoEvidence } from "./video-evidence";

function taskArtifactUrl(taskId: number, relativePath: string): string {
  const encoded = relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `/api/tasks/${taskId}/artifacts/${encoded}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function withServerVerification(
  output: CodexDirectorOutput,
  hasReferenceVideo: boolean,
): CodexDirectorOutput {
  const agentOnlyLimit = /没有重新运行视频取证脚本|没有启动工作台服务或发出HTTP请求/;
  return {
    ...output,
    report: output.report.slice(0, 1200),
    nextSteps: output.nextSteps.slice(0, 3),
    verification: {
      ...output.verification,
      actualLevels: unique([
        hasReferenceVideo
          ? "服务端本地视频准备：本任务证据包已生成并检查"
          : "服务端输入准备：文字和图片清单已生成并检查",
        "Codex 导演分析：指定 Skill 已完成结构化结果返回",
        ...output.verification.actualLevels,
      ]).slice(0, 3),
      passed: unique([
        "本任务 extraction_report.md 与 metadata.json 已由服务端验证存在",
        ...output.verification.passed,
      ]).slice(0, 3),
      blocked: unique(output.verification.blocked).slice(0, 3),
      notTested: unique([
        ...output.verification.notTested.filter((item) => !agentOnlyLimit.test(item)),
        "目标视频模型的素材上传、审核与实际生成未测试",
        "成片下载、逐镜验收、发布和真实业务效果未测试",
      ]).slice(0, 3),
      uncertainties: unique(output.verification.uncertainties).slice(0, 3),
    },
  };
}

function createBriefEvidence(outputDir: string): {
  directory: string;
  contactSheetPath: null;
} {
  const directory = path.join(outputDir, "evidence");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "metadata.json"),
    JSON.stringify(
      {
        source: "text_and_images_only",
        referenceVideoProvided: false,
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(directory, "extraction_report.md"),
    "# Input preparation\n\nNo reference video was supplied. Create from the user brief and attached images only.\n",
    "utf8",
  );
  return { directory, contactSheetPath: null };
}

function resolvedProductionSkill(
  skillName: DirectorSkillName,
  params: Record<string, unknown>,
): DirectorSkillName {
  if (skillName !== "omni-video-director" || params.analysisConfirmed !== true) {
    return skillName;
  }
  const routing =
    params.confirmedRouting && typeof params.confirmedRouting === "object"
      ? (params.confirmedRouting as Record<string, unknown>)
      : null;
  if (routing?.mode === "STRICT_REPLICATION") return "replicate-viral-video";
  if (routing?.mode === "VIRAL_ADAPTATION") return "viral-product-director";
  return "omni-video-director";
}

/** 统一创作入口：有视频先取证，无视频直接整理文字/图片，再调用选定 Skill。 */
export async function runDirectorFeature(
  ctx: FeatureContext,
  skillName: DirectorSkillName,
): Promise<FeatureResult> {
  const hasReferenceVideo = Boolean(ctx.videoId && ctx.videoPath);
  ctx.updateProgress(10, hasReferenceVideo ? "正在读视频" : "正在整理素材");
  const evidence = hasReferenceVideo
    ? await prepareVideoEvidence({
        taskId: ctx.taskId,
        videoPath: ctx.videoPath,
        settings: ctx.ai.configuration,
        signal: ctx.signal,
      })
    : createBriefEvidence(ctx.outputDir);

  ctx.updateProgress(55, hasReferenceVideo ? "视频已读完，正在理解创作方向" : "素材已整理，正在理解创作方向");
  const assets: DirectorInputAsset[] = ctx.assets.map((asset) => ({
    key: asset.key,
    id: asset.id,
    fieldKey: asset.fieldKey,
    name: asset.name,
    path: asset.path,
    mimeType: asset.mimeType,
  }));
  const directorParams: Record<string, unknown> = { ...ctx.params, hasReferenceVideo };
  const understandingOnly = directorParams.analysisConfirmed !== true;
  const effectiveSkillName = resolvedProductionSkill(skillName, directorParams);
  // Real high-effort director runs repeatedly held the subscription stream for
  // close to 15 minutes and then lost the response body. Medium is materially
  // faster and more stable here; the strict hook/story/mapping or replication
  // quality gate below the model remains the acceptance boundary.
  const reasoningEffort = "medium";
  ctx.updateProgress(
    55,
    understandingOnly
      ? effectiveSkillName === "viral-product-director"
        ? "正在抓爆点"
        : effectiveSkillName === "replicate-viral-video"
          ? "正在理解动作与镜头"
          : "正在理解你的想法"
      : "正在精修成片方案",
  );
  const directorRun = await ctx.ai.runDirector({
    skillName: effectiveSkillName,
    taskId: ctx.taskId,
    videoName: ctx.videoName,
    videoPath: ctx.videoPath,
    evidenceDirectory: evidence.directory,
    contactSheetPath: evidence.contactSheetPath,
    params: directorParams,
    assets,
    reasoningEffort,
    signal: ctx.signal,
    onProgress: (message) => ctx.updateProgress(65, message),
  });
  const { output: rawOutput, threadId } = directorRun;
  const output = withServerVerification(rawOutput, hasReferenceVideo);

  ctx.updateProgress(95, "导演方案已生成，正在整理交付包");
  const media: NonNullable<FeatureResult["media"]> = [];
  if (hasReferenceVideo) {
    media.push({
      type: "video",
      url: `/api/videos/${encodeURIComponent(ctx.videoId)}/file`,
      title: "参考视频",
    });
  }
  if (evidence.contactSheetPath) {
    media.push({
      type: "image",
      url: taskArtifactUrl(ctx.taskId, "evidence/contact_sheet.jpg"),
      title: "视频取证接触表",
    });
  }
  for (const asset of ctx.assets) {
    media.push({ type: "image", url: asset.url, title: asset.name });
  }

  return {
    placeholder: false,
    message: output.message,
    report:
      `## 服务端执行回执\n\n` +
      `- 本任务输入已在 D 盘完成受控准备。\n` +
      `- 指定 Codex Skill 已返回结构化导演结果。\n` +
      `- 目标视频模型的上传、积分消费、实际生成、下载、发布和成片验收未执行。\n\n` +
      output.report,
    media,
    nextSteps: output.nextSteps,
    extra: {
      skill: effectiveSkillName,
      codexThreadId: threadId,
      director: output,
      faceReferencePolicy:
        ctx.params.faceReferencePolicy === "no_faces"
          ? "no_faces"
          : "faces_allowed",
      targetModel: String(ctx.params.targetModel ?? "auto"),
      inputAssets: [
        ...(hasReferenceVideo
          ? [
              {
                assetKey: "REFERENCE_VIDEO",
                name: ctx.videoName,
                type: "video",
                url: `/api/videos/${encodeURIComponent(ctx.videoId)}/file`,
              },
            ]
          : []),
        ...ctx.assets.map((asset) => ({
          assetKey: asset.key,
          name: asset.name,
          type: "image",
          url: asset.url,
        })),
      ],
      evidence: {
        directory: path.relative(ctx.outputDir, evidence.directory) || ".",
        reportUrl: taskArtifactUrl(ctx.taskId, "evidence/extraction_report.md"),
        metadataUrl: taskArtifactUrl(ctx.taskId, "evidence/metadata.json"),
        contactSheetUrl: evidence.contactSheetPath
          ? taskArtifactUrl(ctx.taskId, "evidence/contact_sheet.jpg")
          : null,
      },
      serverVerification: {
        videoEvidence: hasReferenceVideo ? "completed_and_checked" : "not_applicable",
        codexSkill: "completed",
        videoGeneration: "not_tested",
      },
    },
  };
}

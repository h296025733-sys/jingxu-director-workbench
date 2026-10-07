import type { FeatureContext, FeatureDefinition } from "./base";
import { runAutoEditFeature } from "@/lib/auto-edit";

const WATERMARK_ONLY_BRIEF = [
  "只检查并处理上传视频里的平台、生成器或账号水印。",
  "完整保留原视频的全部画面、时长、顺序、速度、原声与构图；不要剪片、加字幕、贴纸、转场、滤镜、配音或音乐。",
  "实拍产品品牌、包装文字、正常字幕和展示中的界面不是水印，不得擦除。",
].join(" ");

async function runWatermarkRemoval(context: FeatureContext) {
  return runAutoEditFeature({
    ...context,
    params: {
      ...context.params,
      watermarkOnly: true,
      brief: WATERMARK_ONLY_BRIEF,
      editMode: "smart",
      editTargetDuration: 0,
      editAspect: "source",
      editCaptions: "off",
      editAudio: "keep",
      editVoice: "original",
      transcribe: false,
    },
  });
}

export const watermarkRemovalFeature: FeatureDefinition = {
  id: "watermark_removal",
  name: "智能去水印",
  description: "识别并处理安全区域里的平台水印，原片内容和声音保持不变。",
  icon: "⌫",
  status: "ready",
  inputSchema: {
    type: "object",
    properties: {
      watermarkOnly: {
        type: "boolean",
        title: "只处理水印",
        default: true,
        uiLayout: "hidden",
      },
    },
  },
  run: runWatermarkRemoval,
};


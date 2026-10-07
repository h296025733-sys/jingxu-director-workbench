import type { FeatureDefinition } from "./base";
import { runDirectorFeature } from "@/lib/director-feature";
import { createDirectorInputSchema } from "./director-input";

/**
 * 保持参考视频的动作顺序、镜头功能、运镜、节奏和时序，仅按需求替换
 * 人物、产品、背景或画风，输出可执行的纯复刻方案而不是直接生成成片。
 */
export const videoReplicationFeature: FeatureDefinition = {
  id: "video_replication",
  name: "镜头复刻",
  description:
    "动作、镜头、节奏贴着原片走，只换主角、产品或场景。",
  icon: "◫",
  status: "ready",
  inputSchema: createDirectorInputSchema({
    briefTitle: "描述你要怎么复刻",
    briefDescription:
      "用普通话说明要保留什么、替换什么、最终长什么样；人物、产品、背景、表情或口播要求都写在这里。",
    briefPlaceholder:
      "例如：动作、镜头和节奏照原片；人物换成拟人外星人，背景换成火星…",
    referenceDelivery: "video_images_text",
    allowVideoReference: true,
  }),
  run: (ctx) => runDirectorFeature(ctx, "replicate-viral-video"),
};

import type { FeatureDefinition } from "./base";
import { runDirectorFeature } from "@/lib/director-feature";
import { createDirectorInputSchema } from "./director-input";

/**
 * 拆解参考爆款中可验证的注意力、痛点、证明与转化机制，再为当前产品
 * 做原创迁移。该模式不承诺动作/镜头一比一复刻。
 */
export const videoBreakdownFeature: FeatureDefinition = {
  id: "video_breakdown",
  name: "爆点重构",
  description:
    "借它的爽点和反转，写成你的新广告。不照抄，只把好看变成好卖。",
  icon: "✦",
  status: "ready",
  inputSchema: createDirectorInputSchema({
    briefTitle: "描述产品和你想要的视频",
    briefDescription:
      "把产品、可核实卖点、目标人群和画面要求一次说清；系统会拆解参考视频的爆点，再重新策划。",
    briefPlaceholder:
      "例如：做一条钻石手机广告。借原片的逆袭爽点，但换成新的产品故事…",
    referenceDelivery: "images_text",
    allowVideoReference: false,
  }),
  run: (ctx) => runDirectorFeature(ctx, "viral-product-director"),
};

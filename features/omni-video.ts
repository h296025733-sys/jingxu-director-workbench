import type { FeatureDefinition } from "./base";
import { runDirectorFeature } from "@/lib/director-feature";
import { createOmniDirectorInputSchema } from "./director-input";

export const omniVideoFeature: FeatureDefinition = {
  id: "omni_video",
  name: "镜序创作",
  description: "把文字、图片和视频交给我，我会自己判断最合适的做法。",
  icon: "✦",
  status: "ready",
  inputSchema: createOmniDirectorInputSchema(),
  run: (ctx) => runDirectorFeature(ctx, "omni-video-director"),
};

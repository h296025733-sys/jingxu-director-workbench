import type { FeatureDefinition } from "./base";
import { autoEditFeature } from "./auto-edit";
import { omniVideoFeature } from "./omni-video";
import { videoBreakdownFeature } from "./video-breakdown";
import { videoReplicationFeature } from "./video-replication";
import { watermarkRemovalFeature } from "./watermark-removal";
import { voiceCloneFeature } from "./voice-clone";

/**
 * 功能注册表：新增功能时，把实现 import 进来并追加到数组即可。
 */
/** New tasks use one automatic entry. Legacy definitions stay available so
 * historical tasks and retries keep working. */
export const features: FeatureDefinition[] = [omniVideoFeature, autoEditFeature, watermarkRemovalFeature, voiceCloneFeature];

const allFeatures: FeatureDefinition[] = [
  omniVideoFeature,
  autoEditFeature,
  watermarkRemovalFeature,
  voiceCloneFeature,
  videoBreakdownFeature,
  videoReplicationFeature,
];

export function getFeature(id: string): FeatureDefinition | undefined {
  return allFeatures.find((f) => f.id === id);
}

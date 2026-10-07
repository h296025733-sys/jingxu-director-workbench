import type { AIClient } from "@/lib/ai";

export interface FieldOption {
  label: string;
  value: string;
}

export interface FieldSchema {
  type: "string" | "text" | "number" | "boolean" | "select" | "file";
  title: string;
  description?: string;
  placeholder?: string;
  default?: unknown;
  enum?: FieldOption[];
  required?: boolean;
  /** 仅用于 file 字段，例如 image/jpeg,image/png,image/webp。 */
  accept?: string;
  /** file 字段是否允许多选。 */
  multiple?: boolean;
  /** file 字段最多允许上传的文件数。 */
  maxFiles?: number;
  /** 数字字段的最小值。 */
  min?: number;
  /** 数字字段的最大值。 */
  max?: number;
  /** 数字字段的步长。 */
  step?: number;
  /** 表单布局；hidden 仍会把默认值提交给服务端。 */
  uiLayout?: "full" | "half" | "hidden";
}

export interface InputSchema {
  type: "object";
  required?: string[];
  properties: Record<string, FieldSchema>;
}

export interface FeatureResult {
  /** 一句话结果说明 */
  message?: string;
  /** 主文本结果（如拆解报告） */
  report?: string;
  /** 产物媒体（复刻视频、拆解配图等），前端会自动渲染 */
  media?: { type: "video" | "image" | "audio"; url: string; title?: string }[];
  /** 占位结果标记：骨架完成、AI 逻辑待接入 */
  placeholder?: boolean;
  /** 下一步建议 */
  nextSteps?: string[];
  /** 其他结构化数据，前端原样展示 */
  extra?: Record<string, unknown>;
}

export interface FeatureAsset {
  id: string;
  /** 表单中的 file 字段名。 */
  fieldKey: string;
  /** 供提示词与上传计划稳定引用，例如 PRODUCT_IMAGES_1。 */
  key: string;
  name: string;
  path: string;
  mimeType: string;
  url: string;
}

export interface FeatureContext {
  taskId: number;
  createdBy?: string;
  videoId: string;
  videoPath: string;
  videoName: string;
  /** 自动剪辑可选的第二段真实视频；其他功能保持为空。 */
  secondaryVideoId?: string;
  secondaryVideoPath?: string;
  secondaryVideoName?: string;
  /** 自动剪辑可选的独立视频/音频克隆音源；只提取语音，不作为画面素材。 */
  voiceReferenceVideoPath?: string;
  preparedVoiceReferenceDir?: string;
  /** 本任务所有衍生产物的唯一目录，位于项目 data/task-runs 下。 */
  outputDir: string;
  params: Record<string, unknown>;
  assets: FeatureAsset[];
  ai: AIClient;
  signal: AbortSignal;
  updateProgress: (percent: number, message?: string) => void;
}

/**
 * 功能插件基类定义。
 *
 * 新增一个功能只需要三步：
 * 1. 在 features/ 下新建 xxx.ts，按本接口实现一个 FeatureDefinition；
 * 2. 在 features/registry.ts 的数组中注册；
 * 3. 普通员工始终只使用 omni_video；其他定义只用于内部路由或历史兼容。
 */
export interface FeatureDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  /** ready = 已可用；developing = 骨架已就绪，AI 逻辑待接入 */
  status: "ready" | "developing";
  /** 参数表单的 JSON Schema，前端会根据它自动渲染表单 */
  inputSchema: InputSchema;
  run: (ctx: FeatureContext) => Promise<FeatureResult>;
}

export function toFeatureMeta(feature: FeatureDefinition) {
  return {
    id: feature.id,
    name: feature.name,
    description: feature.description,
    icon: feature.icon,
    status: feature.status,
    inputSchema: feature.inputSchema,
  };
}

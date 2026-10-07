export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string;
  is_admin: number;
  disabled: number;
  must_change_password: number;
  admin_note: string;
  created_at: string;
}

export interface UserOut {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

export interface VideoRow {
  id: string;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string;
  created_at: string;
  tags: string;
  task_count?: number;
}

export interface AssetRow {
  id: string;
  original_name: string;
  stored_name: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string;
  created_at: string;
}

export interface AssetOut {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt: string;
  url: string;
}

export type TaskStatus =
  | "pending"
  | "running"
  | "awaiting_confirmation"
  | "succeeded"
  | "failed"
  | "canceled";

export type ReferenceDeliveryMode =
  | "text_only"
  | "images_text"
  | "video_images_text";

export type DeliveryPackageConversionStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed";

export interface TaskDeliveryPackageRow {
  task_id: number;
  delivery_mode: ReferenceDeliveryMode;
  status: DeliveryPackageConversionStatus;
  source_result_json: string;
  result_json: string | null;
  error: string | null;
  selected: number;
  created_by: string;
  requested_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface TaskDeliveryPackageState {
  currentMode: ReferenceDeliveryMode;
  allowedModes: ReferenceDeliveryMode[];
  cachedModes: ReferenceDeliveryMode[];
  conversion: {
    targetMode: ReferenceDeliveryMode;
    status: "pending" | "running" | "failed";
    error: string | null;
  } | null;
}

export type PromptTranslationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed";

export interface TaskPromptTranslationRow {
  task_id: number;
  source_hash: string;
  language: "en";
  status: PromptTranslationStatus;
  source_prompt: string;
  translated_prompt: string | null;
  error: string | null;
  created_by: string;
  requested_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface TaskPromptTranslationState {
  language: "en";
  status: "idle" | PromptTranslationStatus;
  translatedPrompt: string | null;
  error: string | null;
}

export type GeneratedImageStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed";

export interface GeneratedImageRow {
  id: string;
  task_id: number;
  asset_key: string;
  kind: string;
  version: number;
  prompt: string;
  purpose: string;
  avoid: string;
  dependency_keys_json: string;
  dependency_versions_json: string;
  status: GeneratedImageStatus;
  file_name: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  summary: string | null;
  risks_json: string;
  codex_thread_id: string | null;
  adopted: number;
  error: string | null;
  created_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface GeneratedImageOut {
  id: string;
  taskId: number;
  assetKey: string;
  kind: string;
  version: number;
  status: GeneratedImageStatus;
  url: string | null;
  width: number | null;
  height: number | null;
  adopted: boolean;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type ReferencePreparationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "needs_review"
  | "failed";

export interface ReferencePreparationRow {
  id: string;
  task_id: number;
  version: number;
  status: ReferencePreparationStatus;
  file_name: string | null;
  report_name: string | null;
  contact_sheet_name: string | null;
  source_detection_frames: number | null;
  source_detection_count: number | null;
  masked_frames: number | null;
  total_frames: number | null;
  mean_coverage: number | null;
  p95_coverage: number | null;
  max_coverage: number | null;
  post_mask_detector_count: number | null;
  adopted: number;
  error: string | null;
  created_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface ReferencePreparationOut {
  id: string;
  taskId: number;
  version: number;
  status: ReferencePreparationStatus;
  videoUrl: string | null;
  canAdopt: boolean;
  adopted: boolean;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskRow {
  edit_narration_status?: string | null;
  id: number;
  video_id: string;
  video_name: string;
  secondary_video_id: string;
  secondary_video_name: string;
  feature_id: string;
  params_json: string;
  status: TaskStatus;
  progress: number;
  message: string | null;
  result_json: string | null;
  error: string | null;
  asset_schedule_complete: number;
  created_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface VideoOut {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  createdAt: string;
  tags: string[];
  uploadedBy: string;
  /** 当前登录用户是否可以删除该视频（管理员或上传者） */
  canDelete: boolean;
  /** 删除视频时会一起删除的关联任务数。 */
  taskCount: number;
}

export interface TaskOut {
  narrationStatus?: "delivered" | "partial" | "incomplete";
  id: number;
  videoId: string;
  videoName: string;
  secondaryVideoId: string;
  secondaryVideoName: string;
  featureId: string;
  featureName: string;
  featureIcon: string;
  params: Record<string, unknown>;
  status: TaskStatus;
  progress: number;
  message: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Only returned to administrators. */
  createdBy?: string;
  /** Only returned to administrators; falls back to the username. */
  creatorDisplayName?: string;
  /** 当前登录用户是否可以管理该任务（管理员或创建者） */
  canManage: boolean;
  /** 成功任务可在结果页快速切换的交付套餐状态。 */
  deliveryPackage?: TaskDeliveryPackageState;
  /** 当前最终提示词的可缓存英文版本。 */
  promptTranslation?: TaskPromptTranslationState;
}

export interface SettingsRow {
  key: string;
  value: string;
}

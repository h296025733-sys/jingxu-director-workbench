export const WATERMARK_BATCH_MAX_FILES = 20;
export const WATERMARK_BATCH_GLOBAL_BACKLOG = 100;
export interface WatermarkBatchItem {
  id: string;
  batchId: string;
  name: string;
  status: string;
  progress: number;
  taskId: number | null;
  message: string | null;
  createdAt: string;
}

export function watermarkFileProblem(file: { name: string; size: number }): string | null {
  if (!/\.(mp4|mov|m4v|webm|avi|mkv|flv|wmv|ts)$/i.test(file.name)) return "请选择视频文件";
  if (file.size <= 0) return "文件是空的";
  if (file.size > 1024 * 1024 * 1024) return "单条视频不能超过 1GB";
  return null;
}

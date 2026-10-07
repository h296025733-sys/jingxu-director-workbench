import "server-only";
import { db } from "./db";
import { MAX_PENDING_WORK_GLOBAL } from "./concurrency-config";
import { WATERMARK_BATCH_MAX_FILES, WATERMARK_BATCH_GLOBAL_BACKLOG, type WatermarkBatchItem } from "./watermark-batch-contract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export class WatermarkBatchError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
interface IntakeRow { id: string; batch_id: string; created_by: string; video_id: string; video_name: string; status: string; task_id: number | null }
const ACTIVE = `(b.status='waiting' OR (b.status='dispatched' AND t.status IN ('pending','running')))`;

export function addWatermarkBatchItem(owner: string, input: Record<string, unknown>): string {
  const { id, batchId, videoId } = input;
  if (typeof id !== "string" || !UUID.test(id) || typeof batchId !== "string" || !UUID.test(batchId) || typeof videoId !== "string") {
    throw new WatermarkBatchError("批量记录无效，请重新添加视频");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const previous = db.prepare("SELECT * FROM watermark_batch_items WHERE id=?").get(id) as unknown as IntakeRow | undefined;
    if (previous) {
      if (previous.created_by !== owner || previous.batch_id !== batchId || previous.video_id !== videoId) throw new WatermarkBatchError("提交编号已使用，请刷新后重试", 409);
      db.exec("COMMIT");
      return previous.id;
    }
    const repeated = db.prepare("SELECT id FROM watermark_batch_items WHERE created_by=? AND batch_id=? AND video_id=?").get(owner, batchId, videoId) as unknown as { id: string } | undefined;
    if (repeated) { db.exec("COMMIT"); return repeated.id; }
    const video = db.prepare("SELECT original_name, mime_type FROM videos WHERE id=? AND uploaded_by=?").get(videoId, owner) as unknown as { original_name: string; mime_type: string } | undefined;
    if (!video || !video.mime_type.startsWith("video/")) throw new WatermarkBatchError("请选择自己上传的有效视频", 403);
    const batchCount = db.prepare("SELECT COUNT(*) n FROM watermark_batch_items WHERE created_by=? AND batch_id=?").get(owner, batchId) as unknown as { n: number };
    const personal = db.prepare(`SELECT COUNT(*) n FROM watermark_batch_items b LEFT JOIN tasks t ON t.id=b.task_id WHERE b.created_by=? AND ${ACTIVE}`).get(owner) as unknown as { n: number };
    const global = db.prepare(`SELECT COUNT(*) n FROM watermark_batch_items b LEFT JOIN tasks t ON t.id=b.task_id WHERE ${ACTIVE}`).get() as unknown as { n: number };
    if (batchCount.n >= WATERMARK_BATCH_MAX_FILES || personal.n >= WATERMARK_BATCH_MAX_FILES) throw new WatermarkBatchError("最多保留20条待处理视频，等前面的处理结束后可继续提交；已上传素材会保留", 429);
    if (global.n >= WATERMARK_BATCH_GLOBAL_BACKLOG) throw new WatermarkBatchError("批量清单暂时已满，已上传素材会保留，请稍后继续提交", 429);
    db.prepare("INSERT INTO watermark_batch_items (id,batch_id,created_by,video_id,video_name,created_at) VALUES (?,?,?,?,?,?)").run(id, batchId, owner, videoId, video.original_name, new Date().toISOString());
    db.prepare("INSERT INTO audit_logs (actor,action,detail,created_at) VALUES (?,?,?,?)").run(owner, "watermark_batch_add", `添加去水印批量记录 ${id}`, new Date().toISOString());
    db.exec("COMMIT");
    return id;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function listWatermarkBatchItems(owner: string): WatermarkBatchItem[] {
  const rows = db.prepare(`SELECT b.id, b.batch_id AS batchId, b.video_name AS name, b.created_at AS createdAt,
    b.task_id AS taskId, COALESCE(t.progress,0) AS progress,
    CASE WHEN b.status='dispatched' THEN COALESCE(t.status,'deleted') ELSE b.status END AS status,
    CASE WHEN b.status='dispatched' THEN COALESCE(t.error,t.message) ELSE b.message END AS message
    FROM watermark_batch_items b LEFT JOIN tasks t ON t.id=b.task_id WHERE b.created_by=?
    ORDER BY CASE WHEN ${ACTIVE} THEN 0 ELSE 1 END, b.created_at DESC LIMIT 100`).all(owner);
  return rows as unknown as WatermarkBatchItem[];
}

export function cancelWaitingWatermarkItem(owner: string, id: string): void {
  const item = db.prepare("SELECT status FROM watermark_batch_items WHERE id=? AND created_by=?").get(id, owner) as unknown as { status: string } | undefined;
  if (!item) throw new WatermarkBatchError("记录不存在", 404);
  if (item.status === "canceled") return;
  if (item.status !== "waiting") throw new WatermarkBatchError("这条已进入任务队列，请在任务中取消", 409);
  db.prepare("UPDATE watermark_batch_items SET status='canceled', message='已取消待处理' WHERE id=? AND created_by=? AND status='waiting'").run(id, owner);
}

function activeWork(owner?: string): number {
  const where = owner ? " AND created_by=?" : "";
  return Number((db.prepare(`SELECT
    (SELECT COUNT(*) FROM tasks WHERE status IN ('pending','running')${where}) +
    (SELECT COUNT(*) FROM task_delivery_packages WHERE status IN ('pending','running')${where}) +
    (SELECT COUNT(*) FROM task_prompt_translations WHERE status IN ('pending','running')${where}) n`)
    .get(...(owner ? [owner, owner, owner] : [])) as unknown as { n: number }).n);
}

// Synchronous transaction reserves real task slots; caller uses the existing scheduler.
// No model, media process or retry runs while waiting for capacity.
export function dispatchWaitingWatermarks(): number[] {
  const created: number[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const waiting = db.prepare("SELECT * FROM watermark_batch_items WHERE status='waiting' ORDER BY created_at,id").all() as unknown as IntakeRow[];
    let capacity = MAX_PENDING_WORK_GLOBAL - activeWork();
    const usedOwners = new Set<string>();
    for (const item of waiting) {
      if (capacity <= 0) break;
      if (usedOwners.has(item.created_by)) continue;
      const user = db.prepare("SELECT disabled FROM users WHERE username=?").get(item.created_by) as unknown as { disabled: number } | undefined;
      const video = db.prepare("SELECT 1 FROM videos WHERE id=? AND uploaded_by=? AND mime_type LIKE 'video/%'").get(item.video_id, item.created_by);
      if (!user || user.disabled || !video) {
        db.prepare("UPDATE watermark_batch_items SET status='canceled',message=? WHERE id=?").run(!video ? "原视频已不可用" : "账号已停用，待处理已暂停", item.id);
        continue;
      }
      if (activeWork(item.created_by) >= 2) continue;
      // Avoid spending twice if this very video is already being cleaned.
      const existing = db.prepare("SELECT id FROM tasks WHERE created_by=? AND video_id=? AND feature_id='watermark_removal' AND status IN ('pending','running') LIMIT 1").get(item.created_by, item.video_id) as unknown as { id: number } | undefined;
      let taskId = existing?.id;
      if (!taskId) {
        const result = db.prepare(`INSERT INTO tasks(video_id,video_name,feature_id,params_json,status,created_by,created_at)
          VALUES (?,?,'watermark_removal','{"watermarkOnly":true}','pending',?,?)`).run(item.video_id, item.video_name, item.created_by, new Date().toISOString());
        taskId = Number(result.lastInsertRowid);
        created.push(taskId);
        capacity--;
      }
      db.prepare("UPDATE watermark_batch_items SET status='dispatched',task_id=? WHERE id=?").run(taskId, item.id);
      usedOwners.add(item.created_by);
    }
    db.exec("COMMIT");
    return created;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

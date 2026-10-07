import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ASSET_DIR,
  DB_PATH,
  DATA_DIR,
  OPS_REFERENCE_VIDEO_DIR,
  THUMB_DIR,
  UPLOAD_DIR,
  VIDEO_UPLOAD_SESSION_DIR,
} from "./paths";
import { hashPassword } from "./password";
import { cleanupOrphanTaskRunsOnce } from "./task-run-storage";
import { initializeChannelOpsSchema } from "./channel-ops";

const TASK_RUN_PROCESS_EPOCH_MS = Date.now() - process.uptime() * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });
fs.mkdirSync(ASSET_DIR, { recursive: true });
fs.mkdirSync(VIDEO_UPLOAD_SESSION_DIR, { recursive: true });
fs.mkdirSync(OPS_REFERENCE_VIDEO_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// WAL 模式 + 忙等待，避免多进程/并发读写时报 database is locked
db.exec("PRAGMA busy_timeout = 5000;");
db.exec("PRAGMA journal_mode = WAL;");
// 写入不需要 fsync 每个事务（WAL 下 crash 安全），提升并发写吞吐
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA foreign_keys = ON;");

// A durable intake list, not extra running jobs. Dispatch still obeys 2/32.
db.exec(`CREATE TABLE IF NOT EXISTS watermark_batch_items (
  id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, created_by TEXT NOT NULL,
  video_id TEXT NOT NULL, video_name TEXT NOT NULL, created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting', task_id INTEGER, message TEXT,
  UNIQUE(created_by, batch_id, video_id)
);
CREATE INDEX IF NOT EXISTS idx_watermark_batch_waiting
  ON watermark_batch_items(status, created_by, created_at);`);

db.exec(`CREATE TABLE IF NOT EXISTS personal_voices (
  id TEXT PRIMARY KEY, created_by TEXT NOT NULL, name TEXT NOT NULL,
  source_ids_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
  archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_voices_owner ON personal_voices(created_by, archived);`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS retired_usernames (
    username TEXT PRIMARY KEY,
    retired_at TEXT NOT NULL,
    retired_by TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime_type TEXT NOT NULL DEFAULT '',
    size_bytes INTEGER NOT NULL DEFAULT 0,
    uploaded_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    uploaded_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS task_assets (
    task_id INTEGER NOT NULL,
    asset_id TEXT NOT NULL,
    field_key TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (task_id, field_key, position)
  );

  CREATE TABLE IF NOT EXISTS video_upload_sessions (
    id TEXT PRIMARY KEY,
    original_name TEXT NOT NULL,
    total_size INTEGER NOT NULL,
    chunk_size INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    uploaded_by TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'video',
    status TEXT NOT NULL DEFAULT 'active',
    video_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL,
    video_name TEXT NOT NULL DEFAULT '',
    secondary_video_id TEXT NOT NULL DEFAULT '',
    secondary_video_name TEXT NOT NULL DEFAULT '',
    feature_id TEXT NOT NULL,
    params_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    progress INTEGER NOT NULL DEFAULT 0,
    message TEXT,
    result_json TEXT,
    error TEXT,
    asset_schedule_complete INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS task_generated_images (
    id TEXT PRIMARY KEY,
    task_id INTEGER NOT NULL,
    asset_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    version INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT '',
    avoid TEXT NOT NULL DEFAULT '',
    dependency_keys_json TEXT NOT NULL DEFAULT '[]',
    dependency_versions_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    file_name TEXT,
    mime_type TEXT,
    width INTEGER,
    height INTEGER,
    summary TEXT,
    risks_json TEXT NOT NULL DEFAULT '[]',
    codex_thread_id TEXT,
    adopted INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    UNIQUE (task_id, asset_key, version)
  );

  CREATE TABLE IF NOT EXISTS task_reference_preparations (
    id TEXT PRIMARY KEY,
    task_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    file_name TEXT,
    report_name TEXT,
    contact_sheet_name TEXT,
    source_detection_frames INTEGER,
    source_detection_count INTEGER,
    masked_frames INTEGER,
    total_frames INTEGER,
    mean_coverage REAL,
    p95_coverage REAL,
    max_coverage REAL,
    post_mask_detector_count INTEGER,
    adopted INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    UNIQUE (task_id, version)
  );

  CREATE TABLE IF NOT EXISTS task_delivery_packages (
    task_id INTEGER NOT NULL,
    delivery_mode TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source_result_json TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    selected INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, delivery_mode)
  );

  CREATE TABLE IF NOT EXISTS task_prompt_translations (
    task_id INTEGER NOT NULL,
    source_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source_prompt TEXT NOT NULL,
    translated_prompt TEXT,
    error TEXT,
    created_by TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, source_hash, language)
  );

  CREATE TABLE IF NOT EXISTS task_instruction_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('create', 'revision')),
    instruction TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_owner_status ON tasks(created_by, status);
  CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_assets_owner_created ON assets(uploaded_by, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_task_assets_task ON task_assets(task_id);
  CREATE INDEX IF NOT EXISTS idx_task_assets_asset ON task_assets(asset_id);
  CREATE INDEX IF NOT EXISTS idx_video_upload_sessions_owner
    ON video_upload_sessions(uploaded_by, status);
  CREATE INDEX IF NOT EXISTS idx_task_generated_images_task
    ON task_generated_images(task_id, asset_key, version DESC);
  CREATE INDEX IF NOT EXISTS idx_task_generated_images_status
    ON task_generated_images(status, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_task_generated_images_adopted
    ON task_generated_images(task_id, asset_key) WHERE adopted = 1;
  CREATE INDEX IF NOT EXISTS idx_task_reference_preparations_task
    ON task_reference_preparations(task_id, version DESC);
  CREATE INDEX IF NOT EXISTS idx_task_reference_preparations_status
    ON task_reference_preparations(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_video_id
    ON tasks(video_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_task_reference_preparations_adopted
    ON task_reference_preparations(task_id) WHERE adopted = 1;
  CREATE INDEX IF NOT EXISTS idx_task_delivery_packages_status
    ON task_delivery_packages(status, updated_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_task_delivery_packages_selected
    ON task_delivery_packages(task_id) WHERE selected = 1;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_task_delivery_packages_active
    ON task_delivery_packages(task_id) WHERE status IN ('pending', 'running');
  CREATE INDEX IF NOT EXISTS idx_task_prompt_translations_status
    ON task_prompt_translations(status, updated_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_task_prompt_translations_active
    ON task_prompt_translations(task_id) WHERE status IN ('pending', 'running');
  CREATE INDEX IF NOT EXISTS idx_task_instruction_history_owner_created
    ON task_instruction_history(created_by, id DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_task_instruction_history_initial
    ON task_instruction_history(task_id) WHERE kind = 'create';
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
`);

// Shared channel-planning ledger. All authenticated users operate on the same
// rows; per-row versions and append-only history are initialized together.
initializeChannelOpsSchema(db);

// Ownership in historical rows still uses the immutable username. Preserve
// deleted names permanently so a later account cannot inherit old work.
db.exec(`
  INSERT OR IGNORE INTO retired_usernames (username, retired_at, retired_by)
  SELECT legacy.username, datetime('now'), 'system'
  FROM (
    SELECT created_by AS username FROM tasks
    UNION
    SELECT uploaded_by AS username FROM videos
    UNION
    SELECT uploaded_by AS username FROM assets
  ) AS legacy
  LEFT JOIN users ON users.username = legacy.username
  WHERE users.id IS NULL AND legacy.username <> '';
`);

// Preserve the brief of every existing task as the user's initial instruction.
// This is idempotent, and the history remains available even if the task itself
// is later deleted. Older tasks can only recover their latest saved revision.
db.exec(`
  INSERT OR IGNORE INTO task_instruction_history
    (task_id, created_by, kind, instruction, created_at)
  SELECT id, created_by, 'create',
         trim(CAST(json_extract(params_json, '$.brief') AS TEXT)), created_at
  FROM tasks
  WHERE json_valid(params_json)
    AND typeof(json_extract(params_json, '$.brief')) = 'text'
    AND trim(CAST(json_extract(params_json, '$.brief') AS TEXT)) <> '';

  INSERT INTO task_instruction_history
    (task_id, created_by, kind, instruction, created_at)
  SELECT t.id, t.created_by, 'revision',
         trim(CAST(json_extract(t.params_json, '$.analysisNotes') AS TEXT)),
         COALESCE(t.started_at, t.created_at)
  FROM tasks t
  WHERE json_valid(t.params_json)
    AND typeof(json_extract(t.params_json, '$.analysisNotes')) = 'text'
    AND trim(CAST(json_extract(t.params_json, '$.analysisNotes') AS TEXT)) <> ''
    AND NOT EXISTS (
      SELECT 1 FROM task_instruction_history h
      WHERE h.task_id = t.id
        AND h.kind = 'revision'
        AND h.instruction = trim(CAST(json_extract(t.params_json, '$.analysisNotes') AS TEXT))
    );
`);

const generatedImageColumns = db
  .prepare("PRAGMA table_info(task_generated_images)")
  .all() as unknown as { name: string }[];
if (!generatedImageColumns.some((column) => column.name === "dependency_versions_json")) {
  try {
    db.exec(
      "ALTER TABLE task_generated_images ADD COLUMN dependency_versions_json TEXT NOT NULL DEFAULT '{}'",
    );
  } catch (error) {
    if (!String(error).includes("duplicate column")) throw error;
  }
}

const taskColumns = db
  .prepare("PRAGMA table_info(tasks)")
  .all() as unknown as { name: string }[];
if (!taskColumns.some((column) => column.name === "edit_narration_status")) {
  db.exec("ALTER TABLE tasks ADD COLUMN edit_narration_status TEXT");
  // One-time metadata migration only; never enqueue or regenerate old work.
  db.exec(`UPDATE tasks SET edit_narration_status = CASE
    WHEN json_extract(result_json,'$.extra.editing.narrationStatus') IN ('partial','incomplete')
      THEN json_extract(result_json,'$.extra.editing.narrationStatus')
    WHEN json_extract(result_json,'$.extra.editing.narrationStatus') IN ('delivered','repaired_continuous_delivery','repaired_full_delivery')
      OR json_extract(result_json,'$.extra.editing.narrationNote') LIKE '已补充%' THEN 'delivered'
    ELSE 'incomplete' END
    WHERE feature_id='auto_edit' AND status='succeeded'
      AND json_valid(params_json) AND json_valid(result_json)
      AND json_extract(params_json,'$.editVoice')='narration'`);
}
if (!taskColumns.some((column) => column.name === "asset_schedule_complete")) {
  try {
    db.exec(
      "ALTER TABLE tasks ADD COLUMN asset_schedule_complete INTEGER NOT NULL DEFAULT 0",
    );
    // Existing tasks predate automatic delivery-asset scheduling. Keep them
    // manual so a migration/restart never spends subscription quota silently.
    db.exec("UPDATE tasks SET asset_schedule_complete=1");
  } catch (error) {
    if (!String(error).includes("duplicate column")) throw error;
  }
}
if (!taskColumns.some((column) => column.name === "secondary_video_id")) {
  try {
    db.exec(
      "ALTER TABLE tasks ADD COLUMN secondary_video_id TEXT NOT NULL DEFAULT ''",
    );
  } catch (error) {
    if (!String(error).includes("duplicate column")) throw error;
  }
}
if (!taskColumns.some((column) => column.name === "secondary_video_name")) {
  try {
    db.exec(
      "ALTER TABLE tasks ADD COLUMN secondary_video_name TEXT NOT NULL DEFAULT ''",
    );
  } catch (error) {
    if (!String(error).includes("duplicate column")) throw error;
  }
}

const deliveryPackageColumns = db
  .prepare("PRAGMA table_info(task_delivery_packages)")
  .all() as unknown as { name: string }[];
if (!deliveryPackageColumns.some((column) => column.name === "requested_by")) {
  try {
    db.exec(
      "ALTER TABLE task_delivery_packages ADD COLUMN requested_by TEXT NOT NULL DEFAULT ''",
    );
    db.exec(
      "UPDATE task_delivery_packages SET requested_by = created_by WHERE requested_by = ''",
    );
  } catch (error) {
    if (!String(error).includes("duplicate column")) throw error;
  }
}

const videoUploadSessionColumns = db
  .prepare("PRAGMA table_info(video_upload_sessions)")
  .all() as unknown as { name: string }[];
if (!videoUploadSessionColumns.some((column) => column.name === "video_id")) {
  try {
    db.exec("ALTER TABLE video_upload_sessions ADD COLUMN video_id TEXT");
  } catch (error) {
    if (!String(error).includes("duplicate column")) throw error;
  }
}
if (!videoUploadSessionColumns.some((column) => column.name === "updated_at")) {
  try {
    db.exec("ALTER TABLE video_upload_sessions ADD COLUMN updated_at TEXT");
  } catch (error) {
    if (!String(error).includes("duplicate column")) throw error;
  }
}
if (!videoUploadSessionColumns.some((column) => column.name === "purpose")) {
  try {
    db.exec(
      "ALTER TABLE video_upload_sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'video'",
    );
  } catch (error) {
    if (!String(error).includes("duplicate column")) throw error;
  }
}
db.exec(
  "UPDATE video_upload_sessions SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = ''",
);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_video_upload_sessions_activity
    ON video_upload_sessions(status, updated_at);
`);

// 迁移：为旧数据库补充 tags 列
const videoColumns = db
  .prepare("PRAGMA table_info(videos)")
  .all() as unknown as { name: string }[];
if (!videoColumns.some((col) => col.name === "tags")) {
  try {
    db.exec("ALTER TABLE videos ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
  } catch (err) {
    if (!String(err).includes("duplicate column")) throw err;
  }
}

// 迁移：为旧数据库补充 users.disabled（账号停用标记）
const userColumns = db
  .prepare("PRAGMA table_info(users)")
  .all() as unknown as { name: string }[];
if (!userColumns.some((col) => col.name === "disabled")) {
  try {
    db.exec("ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0");
  } catch (err) {
    if (!String(err).includes("duplicate column")) throw err;
  }
}
if (!userColumns.some((col) => col.name === "must_change_password")) {
  try {
    db.exec(
      "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0",
    );
  } catch (err) {
    if (!String(err).includes("duplicate column")) throw err;
  }
}
if (!userColumns.some((col) => col.name === "admin_note")) {
  try {
    db.exec("ALTER TABLE users ADD COLUMN admin_note TEXT NOT NULL DEFAULT ''");
  } catch (err) {
    if (!String(err).includes("duplicate column")) throw err;
  }
}

function reconcileDeleteTombstones(
  directory: string,
  pattern: RegExp,
  recordStillExists: (originalName: string) => boolean,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(/* turbopackIgnore: true */ directory, {
      withFileTypes: true,
    });
  } catch (error) {
    console.error("[导演工作台] 扫描删除临时文件失败：", error);
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = pattern.exec(entry.name);
    const originalName = match?.groups?.original;
    if (!originalName) continue;
    const tombstonePath = path.join(
      /* turbopackIgnore: true */ directory,
      entry.name,
    );
    const originalPath = path.join(
      /* turbopackIgnore: true */ directory,
      originalName,
    );
    try {
      if (
        recordStillExists(originalName) &&
        !fs.existsSync(/* turbopackIgnore: true */ originalPath)
      ) {
        fs.renameSync(
          /* turbopackIgnore: true */ tombstonePath,
          originalPath,
        );
      } else {
        fs.rmSync(/* turbopackIgnore: true */ tombstonePath, { force: true });
      }
    } catch (error) {
      console.error("[导演工作台] 恢复/清理删除临时文件失败：", error);
    }
  }
}

const assetExists = db.prepare("SELECT 1 FROM assets WHERE stored_name = ?");
reconcileDeleteTombstones(
  ASSET_DIR,
  /^(?<original>[0-9a-f-]{36}\.(?:jpg|png|webp))\.deleting-[0-9a-f-]{36}$/i,
  (storedName) => Boolean(assetExists.get(storedName)),
);
const videoExists = db.prepare("SELECT 1 FROM videos WHERE stored_name = ?");
reconcileDeleteTombstones(
  UPLOAD_DIR,
  /^(?<original>[0-9a-f-]{36}\.(?:mp4|webm|avi|flv|wmv|ts|wav|mp3|m4a|aac|flac|ogg|opus|wma|aiff|caf))\.delete-[0-9a-f-]{36}$/i,
  (storedName) => Boolean(videoExists.get(storedName)),
);
const videoIdExists = db.prepare("SELECT 1 FROM videos WHERE id = ?");
reconcileDeleteTombstones(
  THUMB_DIR,
  /^(?<original>[0-9a-f-]{36}\.(?:jpg|png|webp))\.delete-[0-9a-f-]{36}$/i,
  (storedName) => Boolean(videoIdExists.get(storedName.slice(0, 36))),
);

// Only the actual web-service launcher may reconcile interrupted work. Merely
// importing this module from a local verification/maintenance process must
// never mark live employees' pending/running tasks as failed.
const isNextProductionBuild =
  process.env.NEXT_PHASE === "phase-production-build" ||
  process.env.NEXT_PRIVATE_BUILD_WORKER === "1";
const startupHolder = globalThis as typeof globalThis & { __dwStartupRecovered?: boolean };
if (process.env.DW_WEB_SERVICE_PROCESS === "1" &&
    process.env.DW_SKIP_STARTUP_RECOVERY !== "1" && !isNextProductionBuild && !startupHolder.__dwStartupRecovered) {
startupHolder.__dwStartupRecovered = true;
db.prepare(
  `UPDATE tasks SET status = 'failed', message = '服务重启导致任务中断',
     error = '服务重启，任务未完成', finished_at = ?
   WHERE status IN ('pending', 'running')`,
).run(new Date().toISOString());

// Reference-image runs are deliberately not resumed after a restart: replaying an
// image generation would spend subscription quota and could create a duplicate.
db.prepare(
  `UPDATE task_generated_images
   SET status = 'failed', error = '服务重启，参考图生成未完成', finished_at = ?
   WHERE status IN ('pending', 'running')`,
).run(new Date().toISOString());

// Face-redaction runs are local but can leave partially encoded media after a
// restart. Do not resume them implicitly; a fresh version can be requested.
db.prepare(
  `UPDATE task_reference_preparations
   SET status = 'failed', error = '服务重启，参考视频处理未完成', finished_at = ?
   WHERE status IN ('pending', 'running')`,
).run(new Date().toISOString());

// A conversion never replaces the currently usable package until it succeeds.
// On restart, keep that selected package intact and make the interrupted target
// explicitly retryable instead of silently spending another Codex call.
db.prepare(
  `UPDATE task_delivery_packages
   SET status = 'failed', error = '服务重启，套餐转换未完成', finished_at = ?, updated_at = ?
   WHERE status IN ('pending', 'running')`,
).run(new Date().toISOString(), new Date().toISOString());

// English prompt generation never replaces the Chinese source. Interrupted
// work is retryable after restart while any earlier cached translation stays.
db.prepare(
  `UPDATE task_prompt_translations
   SET status = 'failed', error = '服务重启，英文翻译未完成', finished_at = ?, updated_at = ?
   WHERE status IN ('pending', 'running')`,
).run(new Date().toISOString(), new Date().toISOString());

const taskRunTaskExists = db.prepare("SELECT 1 FROM tasks WHERE id = ?");
cleanupOrphanTaskRunsOnce({
  processEpochMs: TASK_RUN_PROCESS_EPOCH_MS,
  taskExists: (taskId) => Boolean(taskRunTaskExists.get(taskId)),
});
}

// 首次启动自动创建管理员账号（默认 admin / admin123，可用环境变量 DW_ADMIN_PASSWORD 覆盖）。
// 使用 INSERT OR IGNORE 保证多进程并发初始化时也只会创建一次。
const adminUsername = process.env.DW_ADMIN_USERNAME || "admin";
const adminPassword = process.env.DW_ADMIN_PASSWORD || "admin123";
const adminInsert = db
  .prepare(
    `INSERT OR IGNORE INTO users (username, password_hash, display_name, is_admin, disabled, must_change_password, created_at)
     VALUES (?, ?, ?, 1, 0, 1, ?)`,
  )
  .run(
    adminUsername,
    hashPassword(adminPassword),
    "管理员",
    new Date().toISOString(),
  );
if (Number(adminInsert.changes) > 0) {
  console.log(
    `[导演工作台] 已创建默认管理员账号：${adminUsername}（默认密码 admin123，请登录后修改）`,
  );
}

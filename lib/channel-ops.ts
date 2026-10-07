import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  OPS_COMPLIANCE_STATES,
  OPS_CONTENT_TYPES,
  OPS_STAGES,
  type OpsAccount,
  type OpsChangeAction,
  type OpsChangeLog,
  type OpsContentItem,
  type OpsEntityType,
  type OpsHistoryPage,
  type OpsMutationResult,
  type OpsStore,
  type OpsWorkspaceData,
} from "./channel-ops-types";

export interface OpsActor {
  username: string;
  displayName: string;
}

type UnknownRecord = Record<string, unknown>;
type StoreInput = { name: string } & UnknownRecord;
type AccountInput = {
  storeId: string;
  handle: string;
  displayName: string;
  prefix: string;
  focus: string;
  tone: string;
} & UnknownRecord;
type ItemInput = {
  accountId: string;
  contentCode: string;
  title: string;
  contentType: string;
  plannedDate: string;
  stage: string;
  compliance: string;
  owner: string;
  hook: string;
  cta: string;
  views: number;
  clicks: number;
  ordersCount: number;
} & UnknownRecord;

interface StoreRow {
  id: string;
  name: string;
  version: number;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

interface AccountRow {
  id: string;
  store_id: string;
  handle: string;
  display_name: string;
  prefix: string;
  focus: string;
  tone: string;
  version: number;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

interface ItemRow {
  id: string;
  account_id: string;
  content_code: string;
  title: string;
  content_type: string;
  planned_date: string;
  stage: string;
  compliance: string;
  owner: string;
  hook: string;
  cta: string;
  views: number;
  clicks: number;
  orders_count: number;
  version: number;
  created_at: string;
  updated_at: string;
  updated_by: string;
}

interface HistoryRow {
  id: number;
  actor_username: string;
  actor_display_name: string;
  entity_type: OpsEntityType;
  entity_id: string;
  entity_label: string;
  action: OpsChangeAction;
  summary: string;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

export class OpsInputError extends Error {}

export class OpsNotFoundError extends Error {}

export class OpsConflictError extends Error {
  constructor(
    message: string,
    readonly current: OpsStore | OpsAccount | OpsContentItem,
    readonly fields: string[],
  ) {
    super(message);
  }
}

export class OpsDuplicateError extends Error {}

const STORE_FIELDS = ["name"] as const;
const ACCOUNT_FIELDS = ["storeId", "handle", "displayName", "prefix", "focus", "tone"] as const;
const ITEM_FIELDS = [
  "accountId",
  "contentCode",
  "title",
  "contentType",
  "plannedDate",
  "stage",
  "compliance",
  "owner",
  "hook",
  "cta",
  "views",
  "clicks",
  "ordersCount",
] as const;

const FIELD_LABELS: Record<string, string> = {
  name: "店铺名称",
  storeId: "所属店铺",
  handle: "账号",
  displayName: "显示名称",
  prefix: "编号前缀",
  focus: "内容方向",
  tone: "账号语气",
  accountId: "所属账号",
  contentCode: "内容编号",
  title: "内容选题",
  contentType: "内容类型",
  plannedDate: "计划日期",
  stage: "制作状态",
  compliance: "合规状态",
  owner: "负责人",
  hook: "开头 Hook",
  cta: "CTA",
  views: "播放量",
  clicks: "商品点击",
  ordersCount: "订单数",
};

const DEFAULT_STORE_ID = "store-storetwo-botanical-care";
const DEFAULT_ACCOUNT_A_ID = "account-storetwo-scalp-lab";
const DEFAULT_ACCOUNT_B_ID = "account-storefour-wash-day";

const SEED_ITEMS = [
  ["seed-a01", DEFAULT_ACCOUNT_A_ID, "A01", "完整标签流程｜从成分到使用方法", "标签教育", "2026-08-31", "待发布", "已通过", "Lina", "Before you use an anti-dandruff shampoo, read this box.", "Follow the Drug Facts label."],
  ["seed-a02", DEFAULT_ACCOUNT_A_ID, "A02", "1% Selenium Sulfide：标签怎么读", "成分教育", "2026-09-01", "已发布", "已通过", "Mia", "The number on the front is only the beginning.", "Save this for your next wash day."],
  ["seed-a03", DEFAULT_ACCOUNT_A_ID, "A03", "FAQ｜Can I use this daily?", "FAQ", "2026-09-02", "剪辑中", "待复核", "Mia", "Can I use this daily? Check the Directions first.", "Read the label before use."],
  ["seed-a04", DEFAULT_ACCOUNT_A_ID, "A04", "先看 Directions，再安排洗发日", "错误纠正", "2026-09-04", "脚本完成", "已通过", "Lina", "Your wash-day plan starts on the Drug Facts panel.", "Recommended for use 2–3 times per week."],
  ["seed-a05", DEFAULT_ACCOUNT_A_ID, "A05", "Drug Facts 三秒定位法", "标签教育", "2026-09-06", "选题池", "未检查", "Lina", "Three places to look before the first pump.", "Save this label-reading checklist."],
  ["seed-b01", DEFAULT_ACCOUNT_B_ID, "B01", "Gym day → wash day reset", "生活场景", "2026-09-01", "待生成", "待复核", "Kai", "Post-gym reset, but make it label-first.", "Add it to your next wash-day routine."],
  ["seed-b02", DEFAULT_ACCOUNT_B_ID, "B02", "Office day scalp reset", "办公室场景", "2026-09-03", "脚本完成", "已通过", "Kai", "Long office day? My reset starts before the shower.", "Check the product card for details."],
  ["seed-b03", DEFAULT_ACCOUNT_B_ID, "B03", "黑衣出门前的洗发日准备", "穿搭场景", "2026-09-05", "选题池", "未检查", "Kai", "Black shirt day starts with a better wash-day plan.", "Plan your next wash day."],
  ["seed-b04", DEFAULT_ACCOUNT_B_ID, "B04", "Going-out wash day checklist", "出门场景", "2026-09-05", "待生成", "待复核", "Nina", "Three things I check before going out.", "Keep the routine simple."],
  ["seed-b05", DEFAULT_ACCOUNT_B_ID, "B05", "Shelf-to-shower routine", "产品场景", "2026-09-06", "选题池", "未检查", "Nina", "What stays on my wash-day shelf?", "Read the Directions before use."],
] as const;

function now(): string {
  return new Date().toISOString();
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
  return String(value).trim().slice(0, max);
}

function cleanInteger(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(Math.floor(parsed), 999_999_999_999);
}

function cleanVersion(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeHandle(value: unknown): string {
  const compact = cleanText(value, 60).replace(/\s+/g, "");
  return compact && !compact.startsWith("@") ? `@${compact}` : compact;
}

function normalizePrefix(value: unknown): string {
  return cleanText(value, 8).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeCode(value: unknown): string {
  return cleanText(value, 24).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
}

function assertChoice(value: string, choices: readonly string[], label: string): void {
  if (!choices.includes(value)) throw new OpsInputError(`${label}不在可选范围内，请重新选择。`);
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new OpsInputError("计划日期格式不正确。");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new OpsInputError("计划日期不存在，请重新选择。");
  }
}

function storeFromRow(row: StoreRow): OpsStore {
  return {
    id: row.id,
    name: row.name,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function accountFromRow(row: AccountRow): OpsAccount {
  return {
    id: row.id,
    storeId: row.store_id,
    handle: row.handle,
    displayName: row.display_name,
    prefix: row.prefix,
    focus: row.focus,
    tone: row.tone,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function itemFromRow(row: ItemRow): OpsContentItem {
  return {
    id: row.id,
    accountId: row.account_id,
    contentCode: row.content_code,
    title: row.title,
    contentType: row.content_type,
    plannedDate: row.planned_date,
    stage: row.stage,
    compliance: row.compliance,
    owner: row.owner,
    hook: row.hook,
    cta: row.cta,
    views: Number(row.views),
    clicks: Number(row.clicks),
    ordersCount: Number(row.orders_count),
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function parseSnapshot(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

function mergeEditable<T extends UnknownRecord>(
  current: T,
  base: UnknownRecord,
  desired: UnknownRecord,
  fields: readonly string[],
  baseVersion: number,
): { value: T; changedFields: string[]; merged: boolean } {
  const currentVersion = Number(current.version);
  const changedByUser = fields.filter((field) => !sameValue(desired[field], base[field]));
  if (baseVersion === currentVersion) {
    const changedFields = fields.filter((field) => !sameValue(desired[field], current[field]));
    return { value: { ...current, ...desired }, changedFields, merged: false };
  }
  const conflicts = changedByUser.filter(
    (field) => !sameValue(current[field], base[field]) && !sameValue(current[field], desired[field]),
  );
  if (conflicts.length) {
    throw new OpsConflictError(
      `这条记录已被 ${String(current.updatedBy || "其他同事")} 修改；冲突字段：${conflicts.map((field) => FIELD_LABELS[field] || field).join("、")}。`,
      current as unknown as OpsStore | OpsAccount | OpsContentItem,
      conflicts,
    );
  }
  const value = { ...current };
  for (const field of changedByUser) value[field as keyof T] = desired[field] as T[keyof T];
  return { value, changedFields: changedByUser, merged: changedByUser.length > 0 };
}

function transaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original error if SQLite already rolled back the transaction.
    }
    throw error;
  }
}

function translateDatabaseError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ops_stores.name")) throw new OpsDuplicateError("这个店铺名称已经存在。");
  if (message.includes("ops_accounts.handle")) throw new OpsDuplicateError("这个账号已经存在。");
  if (message.includes("ops_accounts.store_id") && message.includes("prefix")) {
    throw new OpsDuplicateError("这个店铺内的编号前缀已经被使用。");
  }
  if (message.includes("ops_content_items.account_id") && message.includes("content_code")) {
    throw new OpsDuplicateError("这个账号下的内容编号已经存在。");
  }
  throw error;
}

export function initializeChannelOpsSchema(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS ops_stores (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ops_accounts (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      handle TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      focus TEXT NOT NULL DEFAULT '',
      tone TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      FOREIGN KEY (store_id) REFERENCES ops_stores(id) ON DELETE CASCADE,
      UNIQUE (store_id, prefix)
    );

    CREATE TABLE IF NOT EXISTS ops_content_items (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      content_code TEXT NOT NULL,
      title TEXT NOT NULL,
      content_type TEXT NOT NULL,
      planned_date TEXT NOT NULL,
      stage TEXT NOT NULL,
      compliance TEXT NOT NULL,
      owner TEXT NOT NULL,
      hook TEXT NOT NULL DEFAULT '',
      cta TEXT NOT NULL DEFAULT '',
      views INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      orders_count INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES ops_accounts(id) ON DELETE CASCADE,
      UNIQUE (account_id, content_code)
    );

    CREATE TABLE IF NOT EXISTS ops_account_reference_videos (
      account_id TEXT PRIMARY KEY,
      stored_name TEXT NOT NULL UNIQUE,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (account_id) REFERENCES ops_accounts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ops_change_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_username TEXT NOT NULL,
      actor_display_name TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('store', 'account', 'item')),
      entity_id TEXT NOT NULL,
      entity_label TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
      summary TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ops_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ops_accounts_store ON ops_accounts(store_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_ops_items_account_date ON ops_content_items(account_id, planned_date, content_code);
    CREATE INDEX IF NOT EXISTS idx_ops_items_owner ON ops_content_items(owner);
    CREATE INDEX IF NOT EXISTS idx_ops_history_created ON ops_change_logs(id DESC);
    CREATE INDEX IF NOT EXISTS idx_ops_history_actor ON ops_change_logs(actor_username, id DESC);
  `);

  const timestamp = now();
  database.prepare(
    "INSERT OR IGNORE INTO ops_state (id, revision, updated_at) VALUES (1, 0, ?)",
  ).run(timestamp);
  transaction(database, () => {
    // Build workers and the production process can import this module at the
    // same time. Re-check only after holding the write lock so seeding remains
    // exactly-once across connections and processes.
    const count = database.prepare("SELECT COUNT(*) AS count FROM ops_stores").get() as unknown as { count: number };
    if (Number(count.count) > 0) return;
    database.prepare(
      `INSERT INTO ops_stores (id, name, version, created_at, updated_at, updated_by)
       VALUES (?, ?, 1, ?, ?, 'system')`,
    ).run(DEFAULT_STORE_ID, "Storetwo Botanical Care", timestamp, timestamp);
    database.prepare(
      `INSERT INTO ops_accounts
        (id, store_id, handle, display_name, prefix, focus, tone, version, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'system')`,
    ).run(
      DEFAULT_ACCOUNT_A_ID,
      DEFAULT_STORE_ID,
      "@storetwobodycare",
      "Storetwo Scalp Lab",
      "A",
      "标签阅读 · 成分教育 · Directions · FAQ",
      "冷静可信，不以医生身份表达",
      timestamp,
      timestamp,
    );
    database.prepare(
      `INSERT INTO ops_accounts
        (id, store_id, handle, display_name, prefix, focus, tone, version, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'system')`,
    ).run(
      DEFAULT_ACCOUNT_B_ID,
      DEFAULT_STORE_ID,
      "@storefour248",
      "Wash Day Reset | STOREFOUR",
      "B",
      "黑衣 · 出门 · 健身 · 办公室 · 洗发日",
      "生活化场景，突出洗发日节奏",
      timestamp,
      timestamp,
    );
    const insertItem = database.prepare(
      `INSERT INTO ops_content_items
        (id, account_id, content_code, title, content_type, planned_date, stage, compliance,
         owner, hook, cta, version, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'system')`,
    );
    for (const item of SEED_ITEMS) insertItem.run(...item, timestamp, timestamp);
    database.prepare("UPDATE ops_state SET revision = 1, updated_at = ? WHERE id = 1").run(timestamp);
  });
}

function normalizeStore(input: UnknownRecord): StoreInput {
  const name = cleanText(input.name, 100);
  if (!name) throw new OpsInputError("请填写店铺名称。");
  return { name };
}

function normalizeAccount(input: UnknownRecord): AccountInput {
  const value = {
    storeId: cleanText(input.storeId, 100),
    handle: normalizeHandle(input.handle),
    displayName: cleanText(input.displayName, 100),
    prefix: normalizePrefix(input.prefix),
    focus: cleanText(input.focus, 240),
    tone: cleanText(input.tone, 240),
  };
  if (!value.storeId || !value.handle || !value.displayName || !value.prefix) {
    throw new OpsInputError("请完整填写所属店铺、账号、显示名称和编号前缀。");
  }
  return value;
}

function normalizeItem(input: UnknownRecord): ItemInput {
  const value = {
    accountId: cleanText(input.accountId, 100),
    contentCode: normalizeCode(input.contentCode),
    title: cleanText(input.title, 180),
    contentType: cleanText(input.contentType, 60),
    plannedDate: cleanText(input.plannedDate, 10),
    stage: cleanText(input.stage, 40),
    compliance: cleanText(input.compliance, 40),
    owner: cleanText(input.owner, 60),
    hook: cleanText(input.hook, 500),
    cta: cleanText(input.cta, 300),
    views: cleanInteger(input.views),
    clicks: cleanInteger(input.clicks),
    ordersCount: cleanInteger(input.ordersCount),
  };
  if (!value.accountId || !value.contentCode || !value.title || !value.owner) {
    throw new OpsInputError("请完整填写所属账号、内容编号、内容选题和负责人。");
  }
  assertChoice(value.contentType, OPS_CONTENT_TYPES, "内容类型");
  assertChoice(value.stage, OPS_STAGES, "制作状态");
  assertChoice(value.compliance, OPS_COMPLIANCE_STATES, "合规状态");
  assertDate(value.plannedDate);
  return value;
}

export function createChannelOpsStore(database: DatabaseSync) {
  const currentRevision = (): number => {
    const row = database.prepare("SELECT revision FROM ops_state WHERE id = 1").get() as unknown as { revision: number };
    return Number(row.revision);
  };

  const bumpRevision = (timestamp: string): number => {
    database.prepare("UPDATE ops_state SET revision = revision + 1, updated_at = ? WHERE id = 1").run(timestamp);
    return currentRevision();
  };

  const appendHistory = (
    actor: OpsActor,
    entityType: OpsEntityType,
    entityId: string,
    entityLabel: string,
    action: OpsChangeAction,
    summary: string,
    before: unknown,
    after: unknown,
    timestamp: string,
  ): void => {
    database.prepare(
      `INSERT INTO ops_change_logs
        (actor_username, actor_display_name, entity_type, entity_id, entity_label,
         action, summary, before_json, after_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      actor.username,
      actor.displayName,
      entityType,
      entityId,
      entityLabel,
      action,
      summary,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      timestamp,
    );
  };

  const findStore = (id: string): OpsStore | null => {
    const row = database.prepare("SELECT * FROM ops_stores WHERE id = ?").get(id) as unknown as StoreRow | undefined;
    return row ? storeFromRow(row) : null;
  };

  const findAccount = (id: string): OpsAccount | null => {
    const row = database.prepare("SELECT * FROM ops_accounts WHERE id = ?").get(id) as unknown as AccountRow | undefined;
    return row ? accountFromRow(row) : null;
  };

  const findItem = (id: string): OpsContentItem | null => {
    const row = database.prepare("SELECT * FROM ops_content_items WHERE id = ?").get(id) as unknown as ItemRow | undefined;
    return row ? itemFromRow(row) : null;
  };

  const assertStoreExists = (id: string): void => {
    if (!findStore(id)) throw new OpsInputError("所选店铺不存在，请刷新后重试。");
  };

  const assertAccountExists = (id: string): void => {
    if (!findAccount(id)) throw new OpsInputError("所选账号不存在，请刷新后重试。");
  };

  const updateSummary = (entityLabel: string, changedFields: string[]): string =>
    `修改了${entityLabel}的${changedFields.map((field) => FIELD_LABELS[field] || field).join("、")}`;

  const workspace = (): OpsWorkspaceData => {
    const stores = (database.prepare("SELECT * FROM ops_stores ORDER BY created_at, name").all() as unknown as StoreRow[]).map(storeFromRow);
    const accounts = (database.prepare("SELECT * FROM ops_accounts ORDER BY created_at, display_name").all() as unknown as AccountRow[]).map(accountFromRow);
    const items = (database.prepare(
      "SELECT * FROM ops_content_items ORDER BY planned_date, content_code, created_at",
    ).all() as unknown as ItemRow[]).map(itemFromRow);
    const state = database.prepare("SELECT revision, updated_at FROM ops_state WHERE id = 1").get() as unknown as {
      revision: number;
      updated_at: string;
    };
    return {
      revision: Number(state.revision),
      latestChangeAt: Number(state.revision) > 1 ? state.updated_at : null,
      stores,
      accounts,
      items,
    };
  };

  const createStore = (input: UnknownRecord, actor: OpsActor): OpsMutationResult<OpsStore> => {
    const value = normalizeStore(input);
    try {
      return transaction(database, () => {
        const timestamp = now();
        const id = `store-${randomUUID()}`;
        database.prepare(
          `INSERT INTO ops_stores (id, name, version, created_at, updated_at, updated_by)
           VALUES (?, ?, 1, ?, ?, ?)`,
        ).run(id, value.name, timestamp, timestamp, actor.username);
        const created = findStore(id);
        if (!created) throw new Error("店铺写入后无法读取");
        appendHistory(actor, "store", id, created.name, "create", `新增了店铺 ${created.name}`, null, created, timestamp);
        return { value: created, revision: bumpRevision(timestamp), merged: false, changed: true };
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  };

  const createAccount = (input: UnknownRecord, actor: OpsActor): OpsMutationResult<OpsAccount> => {
    const value = normalizeAccount(input);
    try {
      return transaction(database, () => {
        assertStoreExists(String(value.storeId));
        const timestamp = now();
        const id = `account-${randomUUID()}`;
        database.prepare(
          `INSERT INTO ops_accounts
            (id, store_id, handle, display_name, prefix, focus, tone, version, created_at, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        ).run(
          id,
          value.storeId,
          value.handle,
          value.displayName,
          value.prefix,
          value.focus,
          value.tone,
          timestamp,
          timestamp,
          actor.username,
        );
        const created = findAccount(id);
        if (!created) throw new Error("账号写入后无法读取");
        const label = `${created.displayName}（${created.handle}）`;
        appendHistory(actor, "account", id, label, "create", `新增了账号 ${label}`, null, created, timestamp);
        return { value: created, revision: bumpRevision(timestamp), merged: false, changed: true };
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  };

  const createItem = (input: UnknownRecord, actor: OpsActor): OpsMutationResult<OpsContentItem> => {
    const value = normalizeItem(input);
    try {
      return transaction(database, () => {
        assertAccountExists(String(value.accountId));
        const timestamp = now();
        const id = `item-${randomUUID()}`;
        database.prepare(
          `INSERT INTO ops_content_items
            (id, account_id, content_code, title, content_type, planned_date, stage, compliance,
             owner, hook, cta, views, clicks, orders_count, version, created_at, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        ).run(
          id,
          value.accountId,
          value.contentCode,
          value.title,
          value.contentType,
          value.plannedDate,
          value.stage,
          value.compliance,
          value.owner,
          value.hook,
          value.cta,
          value.views,
          value.clicks,
          value.ordersCount,
          timestamp,
          timestamp,
          actor.username,
        );
        const created = findItem(id);
        if (!created) throw new Error("内容规划写入后无法读取");
        const label = `${created.contentCode} · ${created.title}`;
        appendHistory(actor, "item", id, label, "create", `新增了内容规划 ${label}`, null, created, timestamp);
        return { value: created, revision: bumpRevision(timestamp), merged: false, changed: true };
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  };

  const updateStore = (
    id: string,
    input: UnknownRecord,
    base: UnknownRecord,
    baseVersionValue: unknown,
    actor: OpsActor,
  ): OpsMutationResult<OpsStore> => {
    const desired = normalizeStore(input);
    const normalizedBase = normalizeStore(base);
    const baseVersion = cleanVersion(baseVersionValue);
    if (!baseVersion) throw new OpsInputError("编辑版本无效，请刷新后重试。");
    try {
      return transaction(database, () => {
        const current = findStore(id);
        if (!current) throw new OpsNotFoundError("店铺已被其他同事删除，请刷新页面。");
        const merged = mergeEditable(current as unknown as UnknownRecord, normalizedBase, desired, STORE_FIELDS, baseVersion);
        if (!merged.changedFields.length) {
          return { value: current, revision: currentRevision(), merged: false, changed: false };
        }
        const next = normalizeStore(merged.value);
        const timestamp = now();
        database.prepare(
          `UPDATE ops_stores SET name = ?, version = version + 1, updated_at = ?, updated_by = ?
           WHERE id = ? AND version = ?`,
        ).run(next.name, timestamp, actor.username, id, current.version);
        const updated = findStore(id);
        if (!updated) throw new OpsNotFoundError("店铺已被其他同事删除，请刷新页面。");
        appendHistory(actor, "store", id, updated.name, "update", updateSummary(updated.name, merged.changedFields), current, updated, timestamp);
        return { value: updated, revision: bumpRevision(timestamp), merged: merged.merged, changed: true };
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  };

  const updateAccount = (
    id: string,
    input: UnknownRecord,
    base: UnknownRecord,
    baseVersionValue: unknown,
    actor: OpsActor,
  ): OpsMutationResult<OpsAccount> => {
    const desired = normalizeAccount(input);
    const normalizedBase = normalizeAccount(base);
    const baseVersion = cleanVersion(baseVersionValue);
    if (!baseVersion) throw new OpsInputError("编辑版本无效，请刷新后重试。");
    try {
      return transaction(database, () => {
        const current = findAccount(id);
        if (!current) throw new OpsNotFoundError("账号已被其他同事删除，请刷新页面。");
        const merged = mergeEditable(current as unknown as UnknownRecord, normalizedBase, desired, ACCOUNT_FIELDS, baseVersion);
        if (!merged.changedFields.length) {
          return { value: current, revision: currentRevision(), merged: false, changed: false };
        }
        const next = normalizeAccount(merged.value);
        assertStoreExists(next.storeId);
        const timestamp = now();
        database.prepare(
          `UPDATE ops_accounts SET store_id = ?, handle = ?, display_name = ?, prefix = ?, focus = ?, tone = ?,
             version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?`,
        ).run(
          next.storeId,
          next.handle,
          next.displayName,
          next.prefix,
          next.focus,
          next.tone,
          timestamp,
          actor.username,
          id,
          current.version,
        );
        const updated = findAccount(id);
        if (!updated) throw new OpsNotFoundError("账号已被其他同事删除，请刷新页面。");
        const label = `${updated.displayName}（${updated.handle}）`;
        appendHistory(actor, "account", id, label, "update", updateSummary(label, merged.changedFields), current, updated, timestamp);
        return { value: updated, revision: bumpRevision(timestamp), merged: merged.merged, changed: true };
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  };

  const updateItem = (
    id: string,
    input: UnknownRecord,
    base: UnknownRecord,
    baseVersionValue: unknown,
    actor: OpsActor,
  ): OpsMutationResult<OpsContentItem> => {
    const desired = normalizeItem(input);
    const normalizedBase = normalizeItem(base);
    const baseVersion = cleanVersion(baseVersionValue);
    if (!baseVersion) throw new OpsInputError("编辑版本无效，请刷新后重试。");
    try {
      return transaction(database, () => {
        const current = findItem(id);
        if (!current) throw new OpsNotFoundError("内容规划已被其他同事删除，请刷新页面。");
        const merged = mergeEditable(current as unknown as UnknownRecord, normalizedBase, desired, ITEM_FIELDS, baseVersion);
        if (!merged.changedFields.length) {
          return { value: current, revision: currentRevision(), merged: false, changed: false };
        }
        const next = normalizeItem(merged.value);
        assertAccountExists(next.accountId);
        const timestamp = now();
        database.prepare(
          `UPDATE ops_content_items SET account_id = ?, content_code = ?, title = ?, content_type = ?,
             planned_date = ?, stage = ?, compliance = ?, owner = ?, hook = ?, cta = ?, views = ?,
             clicks = ?, orders_count = ?, version = version + 1, updated_at = ?, updated_by = ?
           WHERE id = ? AND version = ?`,
        ).run(
          next.accountId,
          next.contentCode,
          next.title,
          next.contentType,
          next.plannedDate,
          next.stage,
          next.compliance,
          next.owner,
          next.hook,
          next.cta,
          next.views,
          next.clicks,
          next.ordersCount,
          timestamp,
          actor.username,
          id,
          current.version,
        );
        const updated = findItem(id);
        if (!updated) throw new OpsNotFoundError("内容规划已被其他同事删除，请刷新页面。");
        const label = `${updated.contentCode} · ${updated.title}`;
        appendHistory(actor, "item", id, label, "update", updateSummary(label, merged.changedFields), current, updated, timestamp);
        return { value: updated, revision: bumpRevision(timestamp), merged: merged.merged, changed: true };
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  };

  const deleteEntity = (
    entityType: OpsEntityType,
    id: string,
    baseVersionValue: unknown,
    actor: OpsActor,
  ): { revision: number } => {
    const baseVersion = cleanVersion(baseVersionValue);
    if (!baseVersion) throw new OpsInputError("删除版本无效，请刷新后重试。");
    return transaction(database, () => {
      const timestamp = now();
      if (entityType === "item") {
        const current = findItem(id);
        if (!current) throw new OpsNotFoundError("内容规划已经被其他同事删除。");
        if (current.version !== baseVersion) {
          throw new OpsConflictError("这条内容刚被其他同事修改。请先查看最新内容，再决定是否删除。", current, []);
        }
        const label = `${current.contentCode} · ${current.title}`;
        database.prepare("DELETE FROM ops_content_items WHERE id = ? AND version = ?").run(id, current.version);
        appendHistory(actor, "item", id, label, "delete", `删除了内容规划 ${label}`, current, null, timestamp);
      } else if (entityType === "account") {
        const current = findAccount(id);
        if (!current) throw new OpsNotFoundError("账号已经被其他同事删除。");
        if (current.version !== baseVersion) {
          throw new OpsConflictError("这个账号刚被其他同事修改。请先查看最新内容，再决定是否删除。", current, []);
        }
        const childItems = (database.prepare("SELECT * FROM ops_content_items WHERE account_id = ? ORDER BY content_code").all(id) as unknown as ItemRow[]).map(itemFromRow);
        const label = `${current.displayName}（${current.handle}）`;
        database.prepare("DELETE FROM ops_accounts WHERE id = ? AND version = ?").run(id, current.version);
        appendHistory(actor, "account", id, label, "delete", `删除了账号 ${label}，同时移除 ${childItems.length} 条内容规划`, { ...current, contentItems: childItems }, null, timestamp);
      } else {
        const current = findStore(id);
        if (!current) throw new OpsNotFoundError("店铺已经被其他同事删除。");
        if (current.version !== baseVersion) {
          throw new OpsConflictError("这个店铺刚被其他同事修改。请先查看最新内容，再决定是否删除。", current, []);
        }
        const childAccounts = (database.prepare("SELECT * FROM ops_accounts WHERE store_id = ? ORDER BY created_at").all(id) as unknown as AccountRow[]).map(accountFromRow);
        const childItems = (database.prepare(
          `SELECT items.* FROM ops_content_items items
           INNER JOIN ops_accounts accounts ON accounts.id = items.account_id
           WHERE accounts.store_id = ? ORDER BY items.content_code`,
        ).all(id) as unknown as ItemRow[]).map(itemFromRow);
        database.prepare("DELETE FROM ops_stores WHERE id = ? AND version = ?").run(id, current.version);
        appendHistory(actor, "store", id, current.name, "delete", `删除了店铺 ${current.name}，同时移除 ${childAccounts.length} 个账号和 ${childItems.length} 条内容规划`, { ...current, accounts: childAccounts, contentItems: childItems }, null, timestamp);
      }
      return { revision: bumpRevision(timestamp) };
    });
  };

  const history = (options: {
    page?: number;
    pageSize?: number;
    entityType?: string;
    action?: string;
    search?: string;
  }): OpsHistoryPage => {
    const page = Math.max(1, Math.floor(options.page || 1));
    const pageSize = Math.min(50, Math.max(10, Math.floor(options.pageSize || 30)));
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (["store", "account", "item"].includes(options.entityType || "")) {
      clauses.push("entity_type = ?");
      params.push(String(options.entityType));
    }
    if (["create", "update", "delete"].includes(options.action || "")) {
      clauses.push("action = ?");
      params.push(String(options.action));
    }
    const search = cleanText(options.search, 100);
    if (search) {
      clauses.push("(actor_display_name LIKE ? OR actor_username LIKE ? OR entity_label LIKE ? OR summary LIKE ?)");
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const totalRow = database.prepare(`SELECT COUNT(*) AS count FROM ops_change_logs ${where}`).get(...params) as unknown as { count: number };
    const total = Number(totalRow.count);
    const rows = database.prepare(
      `SELECT * FROM ops_change_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ).all(...params, pageSize, (page - 1) * pageSize) as unknown as HistoryRow[];
    const logs: OpsChangeLog[] = rows.map((row) => ({
      id: Number(row.id),
      actorUsername: row.actor_username,
      actorDisplayName: row.actor_display_name,
      entityType: row.entity_type,
      entityId: row.entity_id,
      entityLabel: row.entity_label,
      action: row.action,
      summary: row.summary,
      before: parseSnapshot(row.before_json),
      after: parseSnapshot(row.after_json),
      createdAt: row.created_at,
    }));
    return { logs, page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) };
  };

  return {
    workspace,
    currentRevision,
    createStore,
    createAccount,
    createItem,
    updateStore,
    updateAccount,
    updateItem,
    deleteEntity,
    history,
  };
}

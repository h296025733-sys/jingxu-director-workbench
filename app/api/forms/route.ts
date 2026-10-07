import { NextResponse } from "next/server";
import {
  createChannelOpsStore,
  OpsConflictError,
  OpsDuplicateError,
  OpsInputError,
  OpsNotFoundError,
} from "@/lib/channel-ops";
import type { OpsEntityType } from "@/lib/channel-ops-types";
import { fail, ok, readJson, withAuth, type NoParams } from "@/lib/api";
import { db } from "@/lib/db";
import { deleteOpsReferenceVideoFile } from "@/lib/storage";

const store = createChannelOpsStore(db);

function cleanEntity(value: unknown): OpsEntityType | null {
  return value === "store" || value === "account" || value === "item" ? value : null;
}

function cleanId(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorResponse(error: unknown): Response {
  if (error instanceof OpsConflictError) {
    return NextResponse.json(
      {
        error: error.message,
        code: "EDIT_CONFLICT",
        current: error.current,
        fields: error.fields,
      },
      { status: 409 },
    );
  }
  if (error instanceof OpsDuplicateError) return fail(error.message, 409);
  if (error instanceof OpsNotFoundError) return fail(error.message, 404);
  if (error instanceof OpsInputError) return fail(error.message, 400);
  throw error;
}

export const GET = withAuth<NoParams>(async () => ok(store.workspace()));

export const POST = withAuth<NoParams>(async (req, _ctx, user) => {
  const body = await readJson(req, 64 * 1024);
  const entity = cleanEntity(body.entity);
  if (!entity) return fail("新增类型无效，请刷新后重试。", 400);
  const data = asRecord(body.data);
  const actor = { username: user.username, displayName: user.displayName };
  try {
    if (entity === "store") return ok(store.createStore(data, actor));
    if (entity === "account") return ok(store.createAccount(data, actor));
    return ok(store.createItem(data, actor));
  } catch (error) {
    return errorResponse(error);
  }
});

export const PUT = withAuth<NoParams>(async (req, _ctx, user) => {
  const body = await readJson(req, 96 * 1024);
  const entity = cleanEntity(body.entity);
  const id = cleanId(body.id);
  if (!entity || !id) return fail("缺少要修改的记录，请刷新后重试。", 400);
  const data = asRecord(body.data);
  const base = asRecord(body.base);
  const actor = { username: user.username, displayName: user.displayName };
  try {
    if (entity === "store") return ok(store.updateStore(id, data, base, body.baseVersion, actor));
    if (entity === "account") return ok(store.updateAccount(id, data, base, body.baseVersion, actor));
    return ok(store.updateItem(id, data, base, body.baseVersion, actor));
  } catch (error) {
    return errorResponse(error);
  }
});

export const DELETE = withAuth<NoParams>(async (req, _ctx, user) => {
  const body = await readJson(req, 32 * 1024);
  const entity = cleanEntity(body.entity);
  const id = cleanId(body.id);
  if (!entity || !id) return fail("缺少要删除的记录，请刷新后重试。", 400);
  try {
    const videoRows = entity === "account"
      ? db.prepare("SELECT stored_name FROM ops_account_reference_videos WHERE account_id = ?").all(id)
      : entity === "store"
        ? db.prepare(
          `SELECT videos.stored_name FROM ops_account_reference_videos videos
           INNER JOIN ops_accounts accounts ON accounts.id = videos.account_id
           WHERE accounts.store_id = ?`,
        ).all(id)
        : [];
    const result = store.deleteEntity(entity, id, body.baseVersion, {
      username: user.username,
      displayName: user.displayName,
    });
    for (const row of videoRows as unknown as Array<{ stored_name: string }>) {
      try {
        deleteOpsReferenceVideoFile(row.stored_name);
      } catch (error) {
        console.error("[镜序] 删除账号参考视频文件失败：", error);
      }
    }
    return ok(result);
  } catch (error) {
    return errorResponse(error);
  }
});

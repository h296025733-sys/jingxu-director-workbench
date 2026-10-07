import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { fail, ok, withAuth } from "@/lib/api";
import { logAudit } from "@/lib/audit";
import { getAssetPath } from "@/lib/storage";
import type { AssetRow } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = withAuth<Ctx>(async (_req, ctx, user) => {
  const { id } = await ctx.params;
  let transactionStarted = false;
  let committed = false;
  let originalPath = "";
  let tombstonePath = "";

  try {
    db.exec("BEGIN IMMEDIATE");
    transactionStarted = true;

    const row = db
      .prepare("SELECT * FROM assets WHERE id = ?")
      .get(id) as unknown as AssetRow | undefined;
    if (!row) {
      db.exec("ROLLBACK");
      transactionStarted = false;
      return fail("参考图片不存在", 404);
    }
    if (!user.isAdmin && row.uploaded_by !== user.username) {
      db.exec("ROLLBACK");
      transactionStarted = false;
      return fail("只能删除自己上传的参考图片", 403);
    }

    const linkRow = db
      .prepare(
        "SELECT COUNT(*) AS count FROM task_assets WHERE asset_id = ?",
      )
      .get(id) as unknown as { count: number };
    if (Number(linkRow.count) > 0) {
      db.exec("ROLLBACK");
      transactionStarted = false;
      return fail("参考图片已关联任务，不能删除", 409);
    }

    originalPath = getAssetPath(row.stored_name);
    if (fs.existsSync(/* turbopackIgnore: true */ originalPath)) {
      tombstonePath = `${originalPath}.deleting-${randomUUID()}`;
      fs.renameSync(originalPath, tombstonePath);
    }

    db.prepare("DELETE FROM assets WHERE id = ?").run(id);
    logAudit(
      user.username,
      "asset_delete",
      `删除参考图片 ${row.original_name} (owner=${row.uploaded_by}, id=${row.id})`,
    );
    db.exec("COMMIT");
    transactionStarted = false;
    committed = true;

    if (tombstonePath) {
      try {
        fs.rmSync(tombstonePath, { force: true });
      } catch (cleanupError) {
        // The database deletion is already committed; surface cleanup in logs
        // without turning a successful logical deletion into a misleading 500.
        console.error("[导演工作台] 清理已删除参考图片文件失败：", cleanupError);
      }
    }
    return ok({ message: "已删除" });
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
    }
    if (!committed && tombstonePath && fs.existsSync(tombstonePath)) {
      try {
        fs.renameSync(tombstonePath, originalPath);
      } catch (restoreError) {
        console.error("[导演工作台] 恢复参考图片文件失败：", restoreError);
      }
    }
    throw error;
  }
});

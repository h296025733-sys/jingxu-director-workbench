import { ok, withAuth, type NoParams } from "@/lib/api";
import { db } from "@/lib/db";
import { toTaskSummaryOut } from "@/lib/dto";
import { features } from "@/features/registry";
import { toFeatureMeta } from "@/features/base";
import type { TaskRow } from "@/lib/types";

export const GET = withAuth<NoParams>(async (_req, _ctx, user) => {
  const videosCount = (
    (user.isAdmin
      ? db.prepare("SELECT COUNT(*) AS c FROM videos").get()
      : db.prepare("SELECT COUNT(*) AS c FROM videos WHERE uploaded_by = ?").get(user.username)) as unknown as {
      c: number;
    }
  ).c;
  const tasksCount = (
    (user.isAdmin
      ? db.prepare("SELECT COUNT(*) AS c FROM tasks").get()
      : db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE created_by = ?").get(user.username)) as unknown as {
      c: number;
    }
  ).c;
  const statusRows = (user.isAdmin
    ? db.prepare("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status").all()
    : db
        .prepare(
          "SELECT status, COUNT(*) AS c FROM tasks WHERE created_by = ? GROUP BY status",
        )
        .all(user.username)) as unknown as { status: string; c: number }[];
  const recentColumns = `id, video_id, video_name, feature_id,
    CASE WHEN instr(params_json, '"analysisConfirmed":true') > 0
      THEN '{"analysisConfirmed":true}' ELSE '{}' END AS params_json,
    status, edit_narration_status, progress, message, error, created_by, created_at, started_at,
    finished_at, 0 AS asset_schedule_complete, NULL AS result_json`;
  const recentRows = (user.isAdmin
    ? db.prepare(`SELECT ${recentColumns} FROM tasks ORDER BY id DESC LIMIT 8`).all()
    : db
        .prepare(
          `SELECT ${recentColumns} FROM tasks WHERE created_by = ? ORDER BY id DESC LIMIT 8`,
        )
        .all(user.username)) as unknown as TaskRow[];

  return ok({
    videosCount,
    tasksCount,
    statusCounts: Object.fromEntries(
      statusRows.map((r) => [r.status, r.c]),
    ) as Record<string, number>,
    recentTasks: recentRows.map((row) => toTaskSummaryOut(row, false)),
    features: features.map(toFeatureMeta),
  });
});

import { db } from "@/lib/db";
import { fail, ok, withAuth, type NoParams } from "@/lib/api";

interface AuditRow {
  id: number;
  actor: string;
  action: string;
  detail: string;
  created_at: string;
}

export const GET = withAuth<NoParams>(
  async (_req, _ctx, user) => {
    if (!user.isAdmin) return fail("仅管理员可查看审计日志", 403);
    const rows = db
      .prepare(
        "SELECT id, actor, action, detail, created_at FROM audit_logs ORDER BY id DESC LIMIT 200",
      )
      .all() as unknown as AuditRow[];
    return ok({
      logs: rows.map((row) => ({
        id: row.id,
        actor: row.actor,
        action: row.action,
        detail: row.detail,
        createdAt: row.created_at,
      })),
    });
  },
);

import { db } from "./db";

/** 记录关键操作到 audit_logs，供管理员追溯（登录/用户/删除/设置等） */
export function logAudit(
  actor: string,
  action: string,
  detail = "",
): void {
  db.prepare(
    `INSERT INTO audit_logs (actor, action, detail, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(actor, action, detail.slice(0, 500), new Date().toISOString());
}

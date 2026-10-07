import { db } from "@/lib/db";
import { fail, ok, readJson, withAuth } from "@/lib/api";
import { toUserOut } from "@/lib/dto";
import { hashPassword, validatePasswordStrength } from "@/lib/password";
import { logAudit } from "@/lib/audit";
import type { UserRow } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

function countOtherActiveAdmins(targetId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM users WHERE id != ? AND is_admin = 1 AND disabled = 0",
      )
      .get(targetId) as unknown as { c: number }
  ).c;
}

export const PUT = withAuth<Ctx>(async (req, ctx, user) => {
  if (!user.isAdmin) return fail("仅管理员可编辑用户", 403);

  const { id } = await ctx.params;
  const target = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(Number(id)) as unknown as UserRow | undefined;
  if (!target) return fail("用户不存在", 404);
  if (target.id === user.id) {
    return fail("不能在这里修改自己的账号，请使用右上角「修改密码」", 400);
  }

  const body = await readJson(req);
  const displayName =
    typeof body.displayName === "string"
      ? String(body.displayName).trim()
      : target.display_name;
  const isAdmin = typeof body.isAdmin === "boolean" ? body.isAdmin : target.is_admin === 1;
  const disabled = typeof body.disabled === "boolean" ? body.disabled : target.disabled === 1;
  const newPassword =
    typeof body.password === "string" ? String(body.password).trim() : "";

  if (!displayName || displayName.length > 20) {
    return fail("姓名不能为空且不超过 20 个字符");
  }
  if (newPassword) {
    const strengthError = validatePasswordStrength(newPassword);
    if (strengthError) return fail(strengthError);
  }

  // 保护最后一个启用的管理员
  if (
    target.is_admin === 1 &&
    (disabled || !isAdmin) &&
    countOtherActiveAdmins(target.id) === 0
  ) {
    return fail("不能停用或降级最后一个管理员", 400);
  }

  db.prepare(
    `UPDATE users SET display_name = ?, is_admin = ?, disabled = ?,
       password_hash = ?, must_change_password = ?
     WHERE id = ?`,
  ).run(
    displayName,
    isAdmin ? 1 : 0,
    disabled ? 1 : 0,
    newPassword ? hashPassword(newPassword) : target.password_hash,
    newPassword ? 1 : target.must_change_password,
    target.id,
  );

  const updated = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(target.id) as unknown as UserRow;
  logAudit(
    user.username,
    "user_update",
    `更新用户 ${target.username}（角色/状态${newPassword ? "/重置密码" : ""}）`,
  );
  return ok({ user: toUserOut(updated), message: "用户已更新" });
});

export const DELETE = withAuth<Ctx>(async (_req, ctx, user) => {
  if (!user.isAdmin) return fail("仅管理员可删除用户", 403);

  const { id } = await ctx.params;
  const target = db
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(Number(id)) as unknown as UserRow | undefined;
  if (!target) return fail("用户不存在", 404);
  if (target.id === user.id) return fail("不能删除自己的账号", 400);
  if (
    target.is_admin === 1 &&
    countOtherActiveAdmins(target.id) === 0
  ) {
    return fail("不能删除最后一个管理员", 400);
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT OR IGNORE INTO retired_usernames (username, retired_at, retired_by)
       VALUES (?, ?, ?)`,
    ).run(target.username, new Date().toISOString(), user.username);
    db.prepare("DELETE FROM users WHERE id = ?").run(target.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  logAudit(user.username, "user_delete", `删除用户 ${target.username}`);
  return ok({ message: "用户已删除" });
});

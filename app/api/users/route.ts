import { db } from "@/lib/db";
import { fail, ok, readJson, withAuth, type NoParams } from "@/lib/api";
import { toUserOut } from "@/lib/dto";
import { hashPassword, validatePasswordStrength } from "@/lib/password";
import { logAudit } from "@/lib/audit";
import type { UserRow } from "@/lib/types";

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

export const GET = withAuth<NoParams>(
  async (_req, _ctx, user) => {
    if (!user.isAdmin) return fail("仅管理员可查看用户列表", 403);
    const rows = db
      .prepare(
        "SELECT id, username, password_hash, display_name, is_admin, disabled, must_change_password, admin_note, created_at FROM users ORDER BY id",
      )
      .all() as unknown as UserRow[];
    return ok({ users: rows.map(toUserOut) });
  },
);

export const POST = withAuth<NoParams>(
  async (req, _ctx, user) => {
    if (!user.isAdmin) return fail("仅管理员可创建用户", 403);

    const body = await readJson(req);
    const username = String(body.username ?? "").trim();
    const displayName = String(body.displayName ?? "").trim();
    const password = String(body.password ?? "");
    const isAdmin = body.isAdmin === true;

    if (!USERNAME_RE.test(username)) {
      return fail("用户名需为 3-32 位字母、数字、下划线、点或中划线");
    }
    if (!displayName || displayName.length > 20) {
      return fail("姓名不能为空且不超过 20 个字符");
    }
    const strengthError = validatePasswordStrength(password);
    if (strengthError) return fail(strengthError);

    const exists = db
      .prepare("SELECT id FROM users WHERE username = ?")
      .get(username);
    if (exists) return fail("用户名已存在", 400);
    const retired = db
      .prepare("SELECT username FROM retired_usernames WHERE username = ?")
      .get(username);
    if (retired) return fail("该用户名属于历史账号，请换一个用户名", 400);

    const info = db
      .prepare(
        `INSERT INTO users (username, password_hash, display_name, is_admin, disabled, must_change_password, created_at)
         VALUES (?, ?, ?, ?, 0, 1, ?)`,
      )
      .run(
        username,
        hashPassword(password),
        displayName,
        isAdmin ? 1 : 0,
        new Date().toISOString(),
      );
    const created = db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as unknown as UserRow;
    logAudit(
      user.username,
      "user_create",
      `创建用户 ${username}（${isAdmin ? "管理员" : "成员"}）`,
    );
    return ok({ user: toUserOut(created) });
  },
);

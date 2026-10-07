import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import { COOKIE_NAME, signToken } from "@/lib/jwt";
import {
  clearLoginAttempts,
  getClientIp,
  getLoginLockRemaining,
  recordLoginFailure,
} from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit";
import type { UserRow } from "@/lib/types";
import { readJson, RequestBodyTooLargeError } from "@/lib/api";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req, 16 * 1024);
    const username = String(body?.username ?? "").trim();
    const password = String(body?.password ?? "");
    const lockKey = `${username}:${getClientIp(req)}`;

    if (!username || !password) {
      return NextResponse.json({ error: "请输入用户名和密码" }, { status: 400 });
    }

    const remaining = getLoginLockRemaining(lockKey);
    if (remaining > 0) {
      return NextResponse.json(
        {
          error: `失败次数过多，请 ${Math.ceil(remaining / 60000)} 分钟后再试`,
        },
        { status: 429 },
      );
    }

    const row = db
      .prepare("SELECT * FROM users WHERE username = ?")
      .get(username) as unknown as UserRow | undefined;
    if (!row || !verifyPassword(password, row.password_hash)) {
      recordLoginFailure(lockKey);
      logAudit(username || "unknown", "login_failed", `登录失败 IP=${getClientIp(req)}`);
      return NextResponse.json({ error: "用户名或密码错误" }, { status: 401 });
    }
    if (row.disabled === 1) {
      logAudit(username, "login_blocked", "账号已停用");
      return NextResponse.json(
        { error: "该账号已停用，请联系管理员" },
        { status: 403 },
      );
    }
    clearLoginAttempts(lockKey);
    logAudit(username, "login", `登录成功 IP=${getClientIp(req)}`);
    const token = await signToken({
      sub: String(row.id),
      username: row.username,
      displayName: row.display_name,
    });
    const res = NextResponse.json({
      user: {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        isAdmin: row.is_admin === 1,
        mustChangePassword: row.must_change_password === 1,
      },
    });
    res.cookies.set(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return res;
  } catch (err) {
    console.error(err);
    if (err instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "请求内容过大" }, { status: 413 });
    }
    return NextResponse.json({ error: "服务器内部错误" }, { status: 500 });
  }
}

import { cookies } from "next/headers";
import { COOKIE_NAME, verifyToken } from "./jwt";
import { db } from "./db";

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

export async function getSessionUser(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;
  const payload = await verifyToken(token);
  if (!payload) return null;
  const row = db
    .prepare(
      "SELECT id, username, display_name, is_admin, disabled, must_change_password FROM users WHERE id = ?",
    )
    .get(Number(payload.sub)) as unknown as
    | {
        id: number;
        username: string;
        display_name: string;
        is_admin: number;
        disabled: number;
        must_change_password: number;
      }
    | undefined;
  // 账号不存在或已停用时，会话立即失效
  if (!row || row.disabled === 1) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    isAdmin: row.is_admin === 1,
    mustChangePassword: row.must_change_password === 1,
  };
}

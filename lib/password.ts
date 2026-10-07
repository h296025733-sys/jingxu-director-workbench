import crypto from "node:crypto";

const ITERATIONS = 100_000;

/** 返回 null 表示密码合格，否则返回原因 */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) return "密码至少 8 位";
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    return "密码需同时包含字母和数字";
  }
  return null;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(password, salt, ITERATIONS, 64, "sha256")
    .toString("hex");
  return `pbkdf2:${ITERATIONS}:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const [, iterStr, salt, expected] = parts;
  const iterations = Number(iterStr);
  if (!Number.isFinite(iterations)) return false;
  const actual = crypto
    .pbkdf2Sync(password, salt, iterations, 64, "sha256")
    .toString("hex");
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

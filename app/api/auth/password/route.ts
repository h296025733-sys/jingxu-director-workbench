import { db } from "@/lib/db";
import { fail, ok, readJson, withAuth, type NoParams } from "@/lib/api";
import {
  hashPassword,
  validatePasswordStrength,
  verifyPassword,
} from "@/lib/password";
import { logAudit } from "@/lib/audit";

export const PUT = withAuth<NoParams>(async (req, _ctx, user) => {
  const body = await readJson(req);
  const oldPassword = String(body.oldPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  if (!oldPassword || !newPassword) return fail("请填写原密码和新密码");
  const strengthError = validatePasswordStrength(newPassword);
  if (strengthError) return fail(strengthError);

  const row = db
    .prepare("SELECT password_hash FROM users WHERE id = ?")
    .get(user.id) as unknown as { password_hash: string } | undefined;
  if (!row || !verifyPassword(oldPassword, row.password_hash)) {
    return fail("原密码不正确", 400);
  }
  db.prepare(
    "UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?",
  ).run(hashPassword(newPassword), user.id);
  logAudit(user.username, "password_change", "修改了自己的密码");
  return ok({ message: "密码已修改" });
});

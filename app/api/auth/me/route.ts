import { ok, withAuth, type NoParams } from "@/lib/api";

export const GET = withAuth<NoParams>(async (_req, _ctx, user) => {
  return ok({ user });
});

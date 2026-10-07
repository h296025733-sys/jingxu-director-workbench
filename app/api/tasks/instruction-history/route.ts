import { ok, withAuth, type NoParams } from "@/lib/api";
import { listTaskInstructionHistory } from "@/lib/task-instruction-history";

export const GET = withAuth<NoParams>(async (req, _ctx, user) => {
  const requestedLimit = Number(new URL(req.url).searchParams.get("limit") ?? 24);
  return ok({
    history: listTaskInstructionHistory(user.username, requestedLimit),
  });
});

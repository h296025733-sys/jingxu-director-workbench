import { fail, ok, withAuth, type NoParams } from "@/lib/api";
import { createChannelOpsStore } from "@/lib/channel-ops";
import { db } from "@/lib/db";

const store = createChannelOpsStore(db);

function numberParam(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const GET = withAuth<NoParams>(async (req, _ctx, user) => {
  if (!user.isAdmin) return fail("只有管理员可以查看更改记录。", 403);
  const url = new URL(req.url);
  return ok(store.history({
    page: numberParam(url.searchParams.get("page"), 1),
    pageSize: numberParam(url.searchParams.get("pageSize"), 30),
    entityType: url.searchParams.get("entity") || "",
    action: url.searchParams.get("action") || "",
    search: url.searchParams.get("search") || "",
  }));
});

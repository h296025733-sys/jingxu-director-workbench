import { ok, withAuth, type NoParams } from "@/lib/api";
import { createChannelOpsStore } from "@/lib/channel-ops";
import { db } from "@/lib/db";

const store = createChannelOpsStore(db);

export const GET = withAuth<NoParams>(async () => ok({ revision: store.currentRevision() }));

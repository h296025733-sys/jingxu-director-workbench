import { ok, withAuth, type NoParams } from "@/lib/api";
import { features } from "@/features/registry";
import { toFeatureMeta } from "@/features/base";

export const GET = withAuth<NoParams>(async () => {
  return ok({ features: features.map(toFeatureMeta) });
});

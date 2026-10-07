import fs from "node:fs";
import path from "node:path";

/** A retry may overwrite its stem before exiting; preserve the verified stem. */
export function checkpointNarration<T extends {source?: string; lines?: unknown[]}>(ready: T, workDir: string): T {
  if (!ready.lines?.length || !ready.source) return ready;
  const root = fs.realpathSync(workDir);
  const source = fs.realpathSync(ready.source);
  if (!source.startsWith(root + path.sep)) throw new Error("Narration checkpoint source escaped current job");
  const saved = path.join(root, "narration-approved-before-repair.wav");
  fs.copyFileSync(source, saved, fs.constants.COPYFILE_EXCL);
  return {...ready, source:saved};
}

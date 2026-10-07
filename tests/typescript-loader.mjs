import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

// Node's test workers must never import the live database as a side effect.
// Some suites import server modules at top level before their test body runs.
if (process.env.NODE_TEST_CONTEXT && !process.env.DW_TEST_DATA_DIR) {
  process.env.DW_TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "jingxu-node-test-"));
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export%20{}",
      };
    }
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[a-z0-9]+(?:[?#].*)?$/i.test(specifier)
    ) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (fs.existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context);
      }
    }
    if (specifier.startsWith("@/")) {
      const relative = specifier.slice(2);
      const candidate = new URL(`../${relative}.ts`, import.meta.url);
      if (fs.existsSync(fileURLToPath(candidate))) {
        return nextResolve(candidate.href, context);
      }
      const indexCandidate = new URL(`../${relative}/index.ts`, import.meta.url);
      if (fs.existsSync(fileURLToPath(indexCandidate))) {
        return nextResolve(indexCandidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

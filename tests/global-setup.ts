import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTestHome, testRoot } from "./helpers";

/**
 * Refuses to start unless vitest.config.ts put HOME (and the XDG dirs) under the test root, then,
 * at the end, removes the private HOMEs the runner made in the test TMPDIR.
 */
export default function setup() {
  const root = testRoot();
  assertTestHome(process.env["HOME"], root);
  for (const name of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"]) {
    assertTestHome(process.env[name], root);
  }
  return () => {
    const base = tmpdir();
    for (const name of readdirSync(base)) {
      if (name.startsWith("meute-fleet-home-")) rmSync(join(base, name), { recursive: true, force: true });
    }
  };
}

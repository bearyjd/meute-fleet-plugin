import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The single chokepoint for test HOME safety (re-review 08 H1). Every run gets a test root R under
// FLEET_TEST_TMPDIR (default: <repo>/.test-tmp, never the real ~/.cache), and HOME, the XDG dirs and
// TMPDIR all point inside R. tests/global-setup.ts refuses to start unless HOME really is there, and
// tests/fs-guard.ts refuses chmod/chown/rm/rename/unlink outside R in every worker.
// Sandboxes need a directory chain owned by this user or root: the executable checks (rightly) refuse
// a directory owned by anyone else, and on some hosts /tmp is owned by an unmapped uid ("nobody").
const repo = dirname(fileURLToPath(import.meta.url));
const base = process.env["FLEET_TEST_TMPDIR"] ?? join(repo, ".test-tmp");
mkdirSync(base, { recursive: true, mode: 0o700 });
const root = join(realpathSync(base), "root");
const dirs = {
  TMPDIR: join(root, "tmp"),
  HOME: join(root, "home"),
  XDG_CONFIG_HOME: join(root, "xdg", "config"),
  XDG_DATA_HOME: join(root, "xdg", "data"),
  XDG_CACHE_HOME: join(root, "xdg", "cache"),
  XDG_STATE_HOME: join(root, "xdg", "state"),
  XDG_RUNTIME_DIR: join(root, "xdg", "runtime"),
};
// Never chmod through a planted or stale symlink: each dir must be a real directory of ours, and the
// root must not be (or contain) the real home, before anything is changed.
const realHome = realpathSync(userInfo().homedir);
for (const dir of [root, join(root, "xdg"), ...Object.values(dirs)]) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error(`test dir is not a real directory of this user: ${dir}`);
  const real = realpathSync(dir);
  if (real === realHome || realHome.startsWith(`${real}/`)) throw new Error(`test dir is or contains the real home: ${dir}`);
}
for (const dir of [root, join(root, "xdg"), ...Object.values(dirs)]) chmodSync(dir, 0o700);
const testEnv = { ...dirs, FLEET_TEST_TMPDIR: realpathSync(base), FLEET_TEST_ROOT: root };
// The main process too, so globalSetup checks what the workers get.
Object.assign(process.env, testEnv);

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: testEnv,
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/fs-guard.ts"],
  },
});

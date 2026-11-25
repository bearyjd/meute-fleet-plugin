import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname as parentOf, join, resolve, sep } from "node:path";
import type { RunnerConfig } from "../server/runner";

// ---- test HOME safety (re-review 08 H1) ------------------------------------------------------
// vitest.config.ts makes the test root R (FLEET_TEST_ROOT) and points HOME, XDG_* and TMPDIR into
// it. Everything here compares REAL paths: `<R>/x/../..` or a symlink out of R is outside R.

/** The realpath of `path`; for a missing path, the realpath of its deepest existing ancestor plus the rest. */
export function resolveReal(path: string, followLast = true): string {
  const absolute = resolve(path);
  if (!followLast) return join(resolveReal(parentOf(absolute)), basename(absolute));
  try {
    return realpathSync(absolute);
  } catch {
    const parent = parentOf(absolute);
    return parent === absolute ? absolute : join(resolveReal(parent), basename(absolute));
  }
}

export function testRoot(): string {
  const root = process.env["FLEET_TEST_ROOT"];
  if (root === undefined || root === "") throw new Error("FLEET_TEST_ROOT is unset: run the tests through vitest.config.ts");
  return realpathSync(root);
}

export const isUnder = (path: string, root: string): boolean => path === root || path.startsWith(`${root}${sep}`);

/** Throws unless `home` really lies under the test root and is not the user's real home. */
export function assertTestHome(home: string | undefined, root: string = testRoot()): string {
  if (home === undefined || home === "") throw new Error("HOME is unset");
  const real = resolveReal(home);
  const realHome = resolveReal(userInfo().homedir);
  if (real === realHome || !isUnder(real, root) || real === root) {
    throw new Error(`HOME is not a test HOME under the test root: ${home}`);
  }
  return real;
}

/** A child HOME that tests may change: a `meute-fleet-home-*` directory directly in the test TMPDIR. */
export function assertPrivateTestHome(home: string | undefined, root: string = testRoot()): string {
  const real = assertTestHome(home, root);
  if (parentOf(real) !== resolveReal(tmpdir()) || !basename(real).startsWith("meute-fleet-home-")) {
    throw new Error(`child HOME is not a private test HOME: ${home}`);
  }
  return real;
}

/**
 * tests/fs-guard.ts refuses chmod/chown/rm/rename/unlink outside the test root. A test that must
 * touch one path outside it (readonly-proof's /tmp file) allows that path (and what is under it)
 * here and calls the returned function when done. Only in-process calls are guarded, not child processes.
 */
export function allowOutsideTestRoot(path: string): () => void {
  const allowed = outsideAllowed();
  const real = resolveReal(path, false);
  allowed.add(real);
  return () => allowed.delete(real);
}

export function outsideAllowed(): Set<string> {
  const store = globalThis as { __fleetOutsideAllowed?: Set<string> };
  store.__fleetOutsideAllowed ??= new Set();
  return store.__fleetOutsideAllowed;
}

export interface Sandbox {
  readonly dir: string;
  readonly root: string;
  readonly meute: string;
  /** Written by stubs that record their argv; lives OUTSIDE the Meute root. */
  readonly argsFile: string;
  readonly config: RunnerConfig;
  cleanup(): void;
}

/** A throwaway MEUTE_ROOT whose bin/meute is the given bash script body. */
export function makeSandbox(stubBody: string, overrides: Partial<RunnerConfig> = {}): Sandbox {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-test-")));
  const root = join(dir, "meute root"); // a space on purpose: argv must survive intact
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "state"));
  mkdirSync(join(root, "reports"));
  const meute = join(root, "bin", "meute");
  writeFileSync(meute, `#!/bin/bash\n${stubBody}\n`);
  chmodSync(meute, 0o755);
  const argsFile = join(dir, "args.out");
  return {
    dir,
    root,
    meute,
    argsFile,
    config: { meutePath: meute, meuteRoot: root, ...overrides },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Stub body that appends one NUL-delimited line per argv element to args.out beside the root. */
export const RECORD_ARGS = 'for a in "$@"; do printf "%s\\0" "$a"; done >> "$(dirname "$MEUTE_ROOT")/args.out"; printf "\\n" >> "$(dirname "$MEUTE_ROOT")/args.out"';

// ---- fixture MEUTE_ROOT ---------------------------------------------------------------------
import { cpSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { FleetConfig } from "../server/config";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(here, "fixtures");

export interface FixtureRoot extends Omit<Sandbox, "config"> {
  readonly config: FleetConfig;
  readonly callsFile: string;
  setMode(mode: string): void;
  calls(): string[];
}

/** A copy of tests/fixtures/meute-root with the replaying stub installed as bin/meute. */
export function makeFixtureRoot(): FixtureRoot {
  const base = makeSandbox("true");
  rmSync(base.root, { recursive: true });
  cpSync(join(FIXTURES, "meute-root"), base.root, { recursive: true });
  mkdirSync(join(base.root, "bin"));
  const stub = readFileSync(join(FIXTURES, "stub-meute.sh"), "utf8").replace("__CAPTURED__", join(FIXTURES, "captured"));
  writeFileSync(base.meute, stub);
  chmodSync(base.meute, 0o755);
  // The stub's control channel (mode + call log) lives in ctl/, the one directory the read-only
  // proof does not hash. sibling/ is a neighbour the proof does hash.
  mkdirSync(join(base.dir, "ctl"));
  mkdirSync(join(base.dir, "sibling"));
  writeFileSync(join(base.dir, "sibling", "file"), "neighbour\n");
  const callsFile = join(base.dir, "ctl", "calls.log");
  return {
    ...base,
    callsFile,
    config: {
      meutePath: base.meute,
      meuteRoot: base.root,
      readinessRecordPath: "/records/record-ready.json",
      readinessPolicyPath: "/records/policy.json",
    },
    setMode: (mode) => writeFileSync(join(base.dir, "ctl", "stub-mode"), mode),
    calls: () => {
      try {
        return readFileSync(callsFile, "utf8").split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

/**
 * Hash every entry of a tree: path, type, mode, size, mtime and ctime (ns), inode, link count and
 * file content. ctime cannot be set back by a user, so it also catches xattr changes, chmod round
 * trips and content rewritten with a restored mtime. atime is left out (reads change it).
 */
export function hashTree(root: string, exclude: readonly string[] = []): string {
  const hash = createHash("sha256");
  const walk = (path: string, rel: string) => {
    if (exclude.includes(rel)) return;
    const info = lstatSync(path, { bigint: true });
    hash.update(`${rel}\0${info.mode}\0${info.size}\0${info.mtimeNs}\0${info.ctimeNs}\0${info.ino}\0${info.nlink}\0`);
    if (info.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name), `${rel}/${name}`);
    } else if (info.isFile()) {
      hash.update(readFileSync(path));
    } else if (info.isSymbolicLink()) {
      hash.update(statSync(path, { throwIfNoEntry: false })?.ino.toString() ?? "dangling");
    }
  };
  walk(root, "");
  return hash.digest("hex");
}

/** Waits until no process of ours has `needle` (e.g. MEUTE_ROOT=<root>) in its environment. */
export async function waitForNoProcessWith(needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const marker = Buffer.from(`${needle}\0`);
  const present = () =>
    readdirSync("/proc").filter((name) => /^[0-9]+$/.test(name)).some((pid) => {
      try {
        return readFileSync(`/proc/${pid}/environ`).includes(marker);
      } catch {
        return false; // gone, or not ours
      }
    });
  while (present()) {
    if (Date.now() > deadline) throw new Error(`a process with ${needle} is still running`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// ---- the real meute CLI (optional, never a silent skip) ---------------------------------------
import { existsSync } from "node:fs";

/**
 * MEUTE_SOURCE_DIR names a meute checkout to copy. There is no default: unset means the real-CLI
 * tests are reported as skipped with this reason, and set-but-unusable fails loudly.
 */
export function realMeuteSource(): { source: string } | { skip: string } {
  const source = process.env["MEUTE_SOURCE_DIR"];
  if (source === undefined || source === "") return { skip: "MEUTE_SOURCE_DIR is unset" };
  for (const needed of [join(source, "bin/meute"), "/usr/bin/jq", "/usr/bin/python3"]) {
    if (!existsSync(needed)) throw new Error(`MEUTE_SOURCE_DIR is set but ${needed} is missing`);
  }
  return { source };
}

/** Copies the fixture root plus meute's bin/lib/tasks/repos.yaml into `root` (never symlinked). */
export function copyRealMeute(source: string, root: string): FleetConfig {
  cpSync(join(FIXTURES, "meute-root"), root, { recursive: true });
  for (const name of ["bin", "lib", "tasks"]) cpSync(join(source, name), join(root, name), { recursive: true });
  cpSync(join(source, "repos.yaml"), join(root, "repos.yaml"));
  chmodSync(join(root, "bin/meute"), 0o755);
  return { meutePath: join(root, "bin/meute"), meuteRoot: root };
}

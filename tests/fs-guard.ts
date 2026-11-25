// setupFiles hook (re-review 08 H1): in every worker, before any test file loads, chmod / chown /
// rm / rmdir / rename / unlink (sync, callback and promises forms) refuse a target whose real path
// is outside the test root. A guarded call that is refused throws and changes nothing.
// Opt out for one path and what is under it: `allowOutsideTestRoot(path)` from tests/helpers.ts.
// Not covered: child processes (bash stubs, execFileSync("rm")) and writes (writeFile, mkdir).
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { assertTestHome, isUnder, outsideAllowed, resolveReal, testRoot } from "./helpers";

const root = testRoot();
// Fail closed if the worker did not get the test environment from vitest.config.ts.
assertTestHome(process.env["HOME"], root);

type Fn = (...args: never[]) => unknown;
// Calls that follow a final symlink (chmod, chown) are judged by the target; the rest by the link.
const FOLLOWS = new Set(["chmod", "chown"]);
const NAMES = ["chmod", "chown", "lchown", "rm", "rmdir", "rename", "unlink"] as const;

function check(name: string, args: unknown[]): void {
  const paths = name === "rename" ? args.slice(0, 2) : args.slice(0, 1);
  for (const path of paths) {
    if (typeof path !== "string" && !(path instanceof URL) && !Buffer.isBuffer(path)) continue;
    const text = path instanceof URL ? path.pathname : String(path);
    const real = resolveReal(text, FOLLOWS.has(name));
    if (!isUnder(real, root) && ![...outsideAllowed()].some((allowed) => isUnder(real, allowed))) {
      throw new Error(`fs-guard: ${name}(${text}) is outside the test root ${root}`);
    }
  }
}

function wrap(target: Record<string, unknown>, key: string, name: string, promised = false): void {
  const original = target[key] as Fn | undefined;
  if (typeof original !== "function") return;
  target[key] = function guarded(this: unknown, ...args: unknown[]) {
    try {
      check(name, args);
    } catch (error) {
      if (promised) return Promise.reject(error);
      throw error;
    }
    return Reflect.apply(original, this, args);
  };
}

export function installFsGuard(): void {
  const sync = fs as unknown as Record<string, unknown>;
  const promises = fs.promises as unknown as Record<string, unknown>;
  for (const name of NAMES) {
    wrap(sync, name, name);
    wrap(sync, `${name}Sync`, name);
    wrap(promises, name, name, true);
  }
  syncBuiltinESMExports();
}

installFsGuard();

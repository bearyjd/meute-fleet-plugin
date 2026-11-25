// What the child may see of the daemon user's session (re-review 07: runner N3/N4, tests B2).
//  - HOME is never configurable: meute runs python3 without -I and git, which execute code from
//    HOME (user site-packages .pth files, ~/.gitconfig). The child gets a plugin-owned, empty,
//    0700 directory made with mkdtemp, re-verified before every spawn and replaced if it changed.
//    meute's health reads HOME only for the install time of meute-daily.timer and falls back to
//    the mtime of state/ (lib/health.sh:57-58); the timers themselves are asked over the bus.
//  - XDG_RUNTIME_DIR is passed only while it is a private directory of the daemon user holding
//    a bus socket of the daemon user that accepts a connection (a leftover socket of a dead user
//    manager makes `systemctl --user` fail, which meute reports as nothing at all).
import { lstatSync, rmSync } from "node:fs";
import { lstat, mkdtemp, readdir, rm, rmdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkAncestors, type SafetyCheck } from "./config";

const BUS_CONNECT_TIMEOUT_MS = 1_000;
const daemonUid = (): number => process.getuid?.() ?? 0;
export const PRIVATE_HOME_UNAVAILABLE =
  "No private HOME could be made for Meute: the daemon's temp dir (TMPDIR, default /tmp) or a directory above it is " +
  "owned by another user or open to others; set TMPDIR for the daemon to a private directory";

async function isPrivateEmptyDir(dir: string, uid: number): Promise<boolean> {
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o7777) !== 0o700) return false;
    if ((await readdir(dir)).length !== 0) return false;
    return (await checkAncestors(dirname(dir), uid)).ok;
  } catch {
    return false;
  }
}

/**
 * Removes a HOME this module made. Recursively only while it is still a 0700 directory of the
 * daemon user (then only that user or root can have written into it); otherwise only if empty, so
 * nothing another user may have planted is followed or touched.
 */
async function discard(dir: string, uid: number): Promise<void> {
  try {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.uid !== uid) return;
    if ((info.mode & 0o7777) === 0o700) await rm(dir, { recursive: true, force: true });
    else await rmdir(dir);
  } catch {
    // left for the temp dir's cleaner (documented under Known limits)
  }
}

let current: Promise<string | null> | undefined;
let made: string | null = null;

async function verifiedOrNew(previous: string | null, uid: number): Promise<string | null> {
  if (previous !== null && (await isPrivateEmptyDir(previous, uid))) return previous;
  if (previous !== null) await discard(previous, uid);
  made = null;
  try {
    const created = await mkdtemp(join(tmpdir(), "meute-fleet-home-"));
    if (await isPrivateEmptyDir(created, uid)) {
      made = created;
      return created;
    }
    await rmdir(created).catch(() => undefined); // M1: never leave a refused (still empty) dir behind
    return null;
  } catch {
    return null;
  }
}

/** Synchronous, for process exit: removes the current private HOME if it is still ours and 0700. */
export function removePrivateHomes(): void {
  const dir = made;
  made = null;
  if (dir === null) return;
  try {
    const info = lstatSync(dir);
    if (info.isDirectory() && info.uid === daemonUid() && (info.mode & 0o7777) === 0o700) rmSync(dir, { recursive: true, force: true });
  } catch {
    // nothing more can be done at exit
  }
}

/**
 * The child's HOME: private, empty and owned by the daemon user, or null when none can be made
 * (the runner then reports PRIVATE_HOME_UNAVAILABLE). One HOME is shared by the daemon's calls while
 * it stays intact; a replaced one is removed, and the current one is removed when the process exits.
 */
export function privateHome(uid: number = daemonUid()): Promise<string | null> {
  if (!process.listeners("exit").includes(removePrivateHomes)) process.on("exit", removePrivateHomes);
  const previous = current ?? Promise.resolve(null);
  current = previous.then((dir) => verifiedOrNew(dir, uid));
  return current;
}

function connects(socket: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection({ path: socket });
    const done = (ok: boolean) => {
      clearTimeout(timer);
      probe.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), BUS_CONNECT_TIMEOUT_MS);
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

/**
 * The positive signal health needs, and the condition for passing XDG_RUNTIME_DIR at all: meute's
 * `systemctl --user` checks print nothing when the user bus is unreachable, which reads exactly
 * like a healthy fleet. Checked on every call. It proves a live bus listener of the daemon user,
 * not that systemctl answered.
 */
export async function checkRuntimeDir(dir: string | undefined, uid: number = daemonUid()): Promise<SafetyCheck> {
  const reason = (text: string): SafetyCheck => ({ ok: false, message: `Health cannot be verified: ${text}` });
  if (!dir) return reason("set XDG_RUNTIME_DIR (for example /run/user/1000) so meute can reach systemd");
  try {
    const runtime = await lstat(dir);
    if (!runtime.isDirectory() || runtime.uid !== uid || (runtime.mode & 0o077) !== 0) {
      return reason("XDG_RUNTIME_DIR is not a private directory of the daemon user");
    }
    const bus = await lstat(join(dir, "bus"));
    if (!bus.isSocket() || bus.uid !== uid) return reason("no user bus socket in XDG_RUNTIME_DIR (is the user session running?)");
  } catch {
    return reason("XDG_RUNTIME_DIR does not exist, or holds no user bus");
  }
  if (!(await connects(join(dir, "bus")))) return reason("no user bus is listening in XDG_RUNTIME_DIR (is the user manager running?)");
  return { ok: true };
}

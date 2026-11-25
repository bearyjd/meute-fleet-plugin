// The code meute runs is the whole checkout, not only bin/meute: it sources lib/*.sh and runs
// python3 on lib/*.py (which also reads lib/__pycache__). So every entry of the tree is checked
// before each spawn, except the data meute writes itself (state/, reports/, .worktrees/ at the
// top) and git's object/ref/log data (the three allowlisted commands never run git in
// MEUTE_ROOT; .git/config, hooks/ and info/ are still walked).
import type { BigIntStats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeText } from "../shared/validate";
import type { SafetyCheck } from "./config";

export const MAX_TREE_ENTRIES = 20_000;
const SKIP_AT_TOP = new Set(["state", "reports", ".worktrees"]);
const SKIP_IN_GIT = new Set(["objects", "refs", "logs"]);
const WRITABLE_BY_OTHERS = 0o022n;

const unsafe = (reason: string): SafetyCheck => ({ ok: false, message: `Unsafe configuration: ${reason}` });
/** L3: which entry, relative to MEUTE_ROOT (names are tree content: sanitized and capped). */
const named = (reason: string, rel: string): SafetyCheck => unsafe(`${reason}: ${sanitizeText(rel, 200).replace(/\s+/g, " ")}`);

// Directory listings keyed by (path, ino, mtime, ctime, size): a listing only changes with the
// directory's mtime. Entries are NOT cached: a mode or owner change of a file changes only that file's
// ctime, so every entry is lstat'd on every walk; the cache saves only the readdir.
const listings = new Map<string, { stamp: string; names: string[] }>();

async function list(path: string, stamp: string): Promise<string[]> {
  const cached = listings.get(path);
  if (cached && cached.stamp === stamp) return cached.names;
  const names = await readdir(path);
  if (listings.size > MAX_TREE_ENTRIES) listings.clear();
  listings.set(path, { stamp, names });
  return names;
}


const stampOf = (info: BigIntStats) => `${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;

/**
 * MEUTE_ROOT itself and every walked entry must be a regular file or a directory (no symlink,
 * FIFO, socket or device), owned by the daemon user or root, and not writable by group or others
 * (sticky is no exemption here, not even for the root: another uid could add top-level names).
 * More than `cap` entries fails closed. A refusal names the entry relative to the root.
 */
export async function checkCodeTree(root: string, uid: number, cap: number = MAX_TREE_ENTRIES): Promise<SafetyCheck> {
  const owner = BigInt(uid);
  let seen = 0;
  const top = await lstat(root, { bigint: true });
  if (!top.isDirectory()) return unsafe("MEUTE_ROOT itself is not a directory");
  if (top.uid !== owner && top.uid !== 0n) return unsafe("MEUTE_ROOT itself is owned by another user");
  if ((top.mode & WRITABLE_BY_OTHERS) !== 0n) return unsafe("MEUTE_ROOT itself is writable by group or others");
  const pending: Array<{ path: string; rel: string; info: BigIntStats }> = [{ path: root, rel: "", info: top }];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const names = (await list(next.path, stampOf(next.info))).filter((name) =>
      !(next.rel === "" && SKIP_AT_TOP.has(name)) && !(next.rel === ".git" && SKIP_IN_GIT.has(name)));
    seen += names.length;
    if (seen > cap) return unsafe(`the Meute code tree has more than ${cap} entries`);
    const parent = next;
    const infos = await Promise.all(names.map(async (name) => ({
      path: join(parent.path, name),
      rel: parent.rel === "" ? name : `${parent.rel}/${name}`,
      info: await lstat(join(parent.path, name), { bigint: true }),
    })));
    for (const entry of infos) {
      const { info, rel } = entry;
      if (info.isSymbolicLink()) return named("the Meute code tree contains a symbolic link", rel);
      if (!info.isFile() && !info.isDirectory()) return named("the Meute code tree contains a special file", rel);
      if (info.uid !== owner && info.uid !== 0n) return named("an entry of the Meute code tree is owned by another user", rel);
      if ((info.mode & WRITABLE_BY_OTHERS) !== 0n) return named("an entry of the Meute code tree is writable by group or others", rel);
      if (info.isDirectory()) pending.push(entry);
    }
  }
  return { ok: true };
}

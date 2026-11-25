// Read-only file access. Only these files can be read, all under MEUTE_ROOT:
//   reports/<repo>/<name>.md, state/lock-info, state/log (tail), state/plan-queue.json
// Every read walks the path one component at a time from a descriptor of the (realpath'd) root,
// openat-style through /proc/self/fd/<dir>/<name>, each component opened with O_NOFOLLOW (and
// O_DIRECTORY for directories), so no symlink is followed anywhere below the root, even if a
// directory is swapped while the walk runs. The opened file's /proc/self/fd link must then name
// exactly the expected path, and fstat on the descriptor must show a regular, single-link file
// within the size cap. The root itself is trusted as configured (see config.ts checks).
import { constants } from "node:fs";
import { open, readlink, realpath, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import type { ErrorCode } from "../shared/contracts";
import { isSafeAbsolutePath, isSafeName } from "../shared/validate";

export const MAX_REPORT_BYTES = 4 * 1024 * 1024; // same cap as meute's own report reader
export const MAX_LOCK_INFO_BYTES = 4096;
export const MAX_QUEUE_BYTES = 1024 * 1024;
export const MAX_TAIL_BYTES = 256 * 1024;
export const DEFAULT_TAIL_BYTES = 64 * 1024;

export type FsError = { ok: false; code: ErrorCode; message: string };
export type TextRead = { ok: true; text: string; size: number } | FsError;
export type TailRead =
  | { ok: true; lines: string[]; size: number; partial: boolean }
  | FsError;

const fsFail = (code: ErrorCode, message: string): FsError => ({ ok: false, code, message });

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const viaFd = (handle: FileHandle, name?: string) => `/proc/self/fd/${handle.fd}${name === undefined ? "" : `/${name}`}`;

function openError(error: unknown): FsError {
  const errno = (error as NodeJS.ErrnoException).code;
  if (errno === "ELOOP") return fsFail("unsafe_path", "Refusing a path that follows a symbolic link");
  // Linux answers ENOTDIR for O_DIRECTORY|O_NOFOLLOW on a symlink.
  if (errno === "ENOTDIR") return fsFail("unsafe_path", "Refusing a path that follows a symbolic link or a non-directory");
  if (errno === "ENOENT") return fsFail("not_found", "File not found");
  return fsFail("unavailable", "File is not readable");
}

/** openat(2)-style walk: one O_NOFOLLOW open per component, each relative to the previous fd. */
async function openContained(rootReal: string, segments: readonly string[]): Promise<{ ok: true; handle: FileHandle } | FsError> {
  let dir: FileHandle;
  try {
    dir = await open(rootReal, DIR_FLAGS);
  } catch {
    return fsFail("unavailable", "Meute root is not readable");
  }
  try {
    // Without /proc the walk cannot be done safely: refuse instead of falling back.
    if ((await readlink(viaFd(dir)).catch(() => null)) !== rootReal) return fsFail("unavailable", "Reads need /proc/self/fd");
    for (const name of segments.slice(0, -1)) {
      const next = await open(viaFd(dir, name), DIR_FLAGS);
      await dir.close().catch(() => undefined);
      dir = next;
    }
    const handle = await open(viaFd(dir, segments[segments.length - 1]), FILE_FLAGS);
    const actual = await readlink(viaFd(handle)).catch(() => null);
    if (actual !== join(rootReal, ...segments)) {
      await handle.close().catch(() => undefined);
      return fsFail("unsafe_path", "Refusing a file that is no longer inside the Meute tree");
    }
    return { ok: true, handle };
  } catch (error) {
    return openError(error);
  } finally {
    await dir.close().catch(() => undefined);
  }
}

async function readRegular(
  root: string,
  segments: readonly string[],
  maxBytes: number,
  tailBytes?: number,
): Promise<{ ok: true; buffer: Buffer; size: number; start: number } | FsError> {
  if (!isSafeAbsolutePath(root)) return fsFail("invalid_config", "Meute root is not configured");
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return fsFail("unavailable", "Meute root is not readable");
  }
  const opened = await openContained(rootReal, segments);
  if (!opened.ok) return opened;
  const handle = opened.handle;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      return fsFail("unsafe_path", "Refusing anything but a plain single-link file");
    }
    if (tailBytes === undefined && info.size > maxBytes) return fsFail("too_large", "File is too large");
    const length = tailBytes === undefined ? info.size : Math.min(info.size, tailBytes);
    const start = info.size - length;
    const buffer = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { ok: true, buffer: buffer.subarray(0, filled), size: info.size, start };
  } catch {
    return fsFail("unavailable", "File is not readable");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// meute decodes reports with Python's strict "utf-8" codec, which keeps a leading BOM.
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

async function readText(root: string, segments: readonly string[], maxBytes: number, strict = false): Promise<TextRead> {
  const result = await readRegular(root, segments, maxBytes);
  if (!result.ok) return result;
  if (!strict) return { ok: true, text: result.buffer.toString("utf8"), size: result.size };
  try {
    return { ok: true, text: STRICT_UTF8.decode(result.buffer), size: result.size };
  } catch {
    return fsFail("unavailable", "Report is not valid UTF-8");
  }
}

export function readReportFile(root: string, repo: string, name: string): Promise<TextRead> {
  if (!isSafeName(repo) || !isSafeName(name)) {
    return Promise.resolve(fsFail("invalid_input", "Invalid report identity"));
  }
  return readText(root, ["reports", repo, `${name}.md`], MAX_REPORT_BYTES, true);
}

export const readLockInfo = (root: string): Promise<TextRead> =>
  readText(root, ["state", "lock-info"], MAX_LOCK_INFO_BYTES);

export const readPlanQueue = (root: string): Promise<TextRead> =>
  readText(root, ["state", "plan-queue.json"], MAX_QUEUE_BYTES);

/** Last `lines` lines of state/log, read from a byte offset near the end. */
export async function tailLog(
  root: string,
  options: { lines: number; tailBytes?: number },
): Promise<TailRead> {
  const requested = options.tailBytes ?? DEFAULT_TAIL_BYTES;
  const tailBytes = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, MAX_TAIL_BYTES) : DEFAULT_TAIL_BYTES;
  const lines = Number.isSafeInteger(options.lines) && options.lines > 0 ? Math.min(options.lines, 100) : 20;
  // One byte more than the window: if the byte before the window is "\n", its first line is whole.
  const result = await readRegular(root, ["state", "log"], Infinity, tailBytes + 1);
  if (!result.ok) return result;
  const partial = result.start > 0;
  let text = result.buffer.toString("utf8");
  if (partial) {
    const cut = text.indexOf("\n");
    text = cut === -1 ? "" : text.slice(cut + 1); // everything before the first "\n" is not a whole line
  }
  const all = text.split("\n").filter((line) => line !== "");
  return { ok: true, lines: all.slice(-lines), size: result.size, partial };
}

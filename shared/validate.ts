// Pure validators shared by the daemon and the app. No Node imports.

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
export const MAX_PATH_LENGTH = 1024;
export const MAX_FINDING_NUMBER = 9999;

export interface FindingRef {
  readonly repo: string;
  readonly name: string;
  readonly n: number;
}

/** A repo directory or report file stem: one path segment, no dot-dot, no separators. */
export function isSafeName(value: unknown): value is string {
  return typeof value === "string" && NAME_RE.test(value) && !value.includes("..");
}

/** `repo/name#n`, the id `meute findings --json` emits. */
export function parseFindingId(value: unknown): FindingRef | null {
  if (typeof value !== "string" || value.length > 300) return null;
  const match = /^([^/#]+)\/([^/#]+)#(0|[1-9][0-9]{0,3})$/.exec(value);
  if (!match) return null;
  const [, repo, name, digits] = match;
  const n = Number(digits);
  if (!isSafeName(repo) || !isSafeName(name)) return null;
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_FINDING_NUMBER) return null;
  return { repo, name, n };
}

/**
 * An absolute POSIX path in canonical form: no NUL or control characters, no empty, dot or
 * dot-dot segments, no trailing slash. Spaces are allowed because argv never goes through a shell.
 */
export function isSafeAbsolutePath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length < 2 || value.length > MAX_PATH_LENGTH) return false;
  if (value[0] !== "/" || CONTROL_RE.test(value)) return false;
  return value
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** Colon-separated absolute directories for PATH. */
export function isSafePathList(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_PATH_LENGTH) return false;
  const parts = value.split(":");
  return parts.length > 0 && parts.every((part) => part === "/" || isSafeAbsolutePath(part));
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const STRIP_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Make untrusted text safe to show: no escape sequences, controls or bidi overrides. */
export function sanitizeText(value: string, maxLength = 4096): string {
  const cleaned = value.replace(ANSI_RE, "").replace(/\r\n?/g, "\n").replace(STRIP_RE, "");
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}…` : cleaned;
}

const PATH_CHAR = "[^\\s\"'`<>|;,()[\\]{}:]";
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replace absolute host paths in text that is about to leave the daemon. Known paths (which may
 * contain spaces) are replaced first, only where they end at a path boundary, together with any
 * path segments that follow; then anything else that looks like an absolute path.
 */
export function redactPaths(value: string, known: readonly string[] = []): string {
  let out = value;
  for (const path of [...known].filter((entry) => entry.length > 1).sort((a, b) => b.length - a.length)) {
    const pattern = new RegExp(`${escapeRegExp(path)}(?!${PATH_CHAR.replace("[^", "[^/")})(?:/${PATH_CHAR}*)*`, "g");
    out = out.replace(pattern, "<path>");
  }
  return out.replace(/(?<![\w.<-])\/(?:[^\s"'`<>|;,()[\]{}:]+\/?)+/g, "<path>");
}

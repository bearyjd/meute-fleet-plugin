// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) the meute-fleet-plugin authors. Parsing logic ported from Meute (AGPL-3.0-only): report.py, inbox.py.
// Parsers for every external payload. Each returns a structured result, never throws.
import { z } from "zod";
import {
  type ApiError, type ErrorCode, type FindingDetail, type FindingsData, type HealthData,
  type ReadinessData, FindingSchema, LockSchema, QueueSchema, ReadinessCheckSchema,
} from "../shared/contracts";
import { redactPaths, sanitizeText } from "../shared/validate";

export type Result<T> = { ok: true; data: T } | { ok: false; error: ApiError };
type Lock = z.infer<typeof LockSchema>;
type Queue = z.infer<typeof QueueSchema>;
export interface LogEntryData {
  time: string;
  fields: Record<string, string>;
}

const bad = <T>(code: ErrorCode, message: string): Result<T> => ({ ok: false, error: { code, message } });

function parseJson(raw: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

const clean = (value: string, max = 300): string => sanitizeText(value, max);

// ---------------------------------------------------------------- findings

const MAX_FINDINGS = 5000;

export function parseFindings(stdout: string, stderr: string): Result<FindingsData> {
  const json = parseJson(stdout);
  if (!json.ok) return bad("malformed", "Findings output was not valid JSON");
  const parsed = z.array(FindingSchema).max(MAX_FINDINGS).safeParse(json.value);
  if (!parsed.success) return bad("malformed", "Findings output had an unexpected shape");
  const findings = parsed.data.map((item) => ({
    ...item,
    id: clean(item.id, 300),
    report: clean(item.report, 300),
    repo: clean(item.repo, 128),
    severity: clean(item.severity, 32),
    title: clean(item.title, 300),
    location: clean(item.location, 300),
    state: clean(item.state, 32),
    inherited: clean(item.inherited, 100),
    verdict: clean(item.verdict, 32),
    pr: clean(item.pr, 300),
  }));
  const skipped = stderr.split("\n").filter((line) => line.startsWith("meute: skipping")).length;
  return { ok: true, data: { findings, skipped } };
}

// --------------------------------------------------------------- readiness

const RawReadiness = z.object({
  version: z.number().int(),
  status: z.string(),
  checks: z.array(z.object({ check: z.string(), status: z.string(), reason: z.string() }).loose()).max(200),
  scope: z.record(z.string(), z.unknown()).optional(),
  observed_at: z.string().optional(),
});

const EXIT_VERDICT = { 0: "ready", 1: "pending", 2: "invalid" } as const;

const knownList = (known: string | readonly string[]): readonly string[] => (typeof known === "string" ? [known] : known);

/** `known`: configured paths (root, record, policy, HOME) to redact whole, spaces included. */
export function parseReadiness(exitCode: number, stdout: string, known: string | readonly string[]): Result<ReadinessData> {
  const knownPaths = knownList(known);
  const json = parseJson(stdout);
  if (!json.ok) return bad("malformed", "Readiness output was not valid JSON");
  const parsed = RawReadiness.safeParse(json.value);
  if (!parsed.success) return bad("malformed", "Readiness output had an unexpected shape");
  const raw = parsed.data;
  if (raw.version !== 1) return bad("unsupported_version", `Readiness version ${raw.version} is not supported`);
  const verdict = (EXIT_VERDICT as Record<number, ReadinessData["verdict"]>)[exitCode];
  // The exit code and the JSON status must agree; "ready" additionally needs at least one check
  // and every check passed (an empty list would pass vacuously).
  if (verdict === undefined || raw.status !== verdict) return bad("malformed", "Readiness exit code and status disagree");
  if (verdict === "ready" && raw.checks.length === 0) {
    return bad("malformed", "Readiness reported ready with no checks");
  }
  if (verdict === "ready" && !raw.checks.every((check) => check.status === "passed")) {
    return bad("malformed", "Readiness reported ready with a check that did not pass");
  }
  const checks = raw.checks.map((item) => {
    const extra = item as Record<string, unknown>;
    const text = (value: unknown, max: number) =>
      typeof value === "string" ? redactPaths(clean(value, max), knownPaths) : undefined;
    return ReadinessCheckSchema.parse({
      check: text(item.check, 100) ?? "",
      status: text(item.status, 32) ?? "",
      reason: text(item.reason, 100) ?? "",
      purpose: text(extra["purpose"], 100),
      detail: text(extra["detail"], 300),
    });
  });
  const scope: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.scope ?? {})) {
    if (typeof value === "string") scope[clean(key, 50)] = redactPaths(clean(value, 200), knownPaths);
  }
  return {
    ok: true,
    data: {
      verdict,
      exitCode,
      version: raw.version,
      checks,
      ...(Object.keys(scope).length > 0 ? { scope } : {}),
      ...(raw.observed_at ? { meuteObservedAt: clean(raw.observed_at, 64) } : {}),
    },
  };
}

// ------------------------------------------------------------------ health

const MAX_PROBLEMS = 50;

/**
 * meute health: exit 0 with byte-empty stdout and stderr is the only healthy answer (whitespace
 * or escape codes alone are unknown). The caller must still require a visible user bus.
 */
export function parseHealth(exitCode: number, stdout: string, stderr: string, known: string | readonly string[]): Result<HealthData> {
  const knownPaths = knownList(known);
  const problems = stdout
    .split("\n")
    .map((line) => redactPaths(clean(line.trim(), 300), knownPaths))
    .filter((line) => line !== "")
    .slice(0, MAX_PROBLEMS);
  if (exitCode === 0 && problems.length === 0) {
    if (stdout !== "" || stderr !== "") {
      return { ok: true, data: { state: "unknown", problems: ["Meute printed diagnostics while checking health"] } };
    }
    return { ok: true, data: { state: "healthy", problems: [] } };
  }
  if (problems.length === 0) {
    return { ok: true, data: { state: "unknown", problems: [`Meute exited ${exitCode} without a reason`] } };
  }
  return { ok: true, data: { state: "unhealthy", problems } };
}

// -------------------------------------------------------------- run status

const PID_RE = /^[0-9]{1,10}$/;

function probePid(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only checks existence; it delivers nothing
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function parseLockInfo(text: string): Result<Lock> {
  const fields: Record<string, string> = {};
  for (const match of text.matchAll(/([a-z]+)=(\S*)/g)) {
    const [, key, value] = match;
    if (key !== undefined && value !== undefined && !(key in fields)) fields[key] = value;
  }
  if (Object.keys(fields).length === 0) return bad("malformed", "lock-info was not understood");
  const rawPid = fields["pid"] ?? "";
  const pid = PID_RE.test(rawPid) ? Number(rawPid) : null;
  const usable = pid !== null && Number.isSafeInteger(pid) && pid > 1;
  return {
    ok: true,
    data: {
      state: "info",
      pid: usable ? pid : null,
      alive: usable ? probePid(pid) : null,
      startedAt: redactPaths(clean(fields["started"] ?? "", 64)),
      slot: redactPaths(clean(fields["slot"] ?? "", 32)),
      key: redactPaths(clean(fields["key"] ?? "", 200)),
    },
  };
}

const LOG_FIELDS = ["week", "slot", "status", "kind", "repo", "task", "tier", "code", "dur", "stage", "pr", "runtime"] as const;

export function parseLogLine(line: string): LogEntryData | null {
  const parts = line.replace(/\r$/, "").split("\t");
  const time = clean(parts[0] ?? "", 64).trim();
  if (time === "") return null;
  const fields: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const key = part.slice(0, at);
    if ((LOG_FIELDS as readonly string[]).includes(key) && !(key in fields)) {
      fields[key] = redactPaths(clean(part.slice(at + 1), 200));
    }
  }
  return { time, fields };
}

const RawQueue = z.object({
  entries: z.array(z.object({ name: z.string(), task: z.string().optional() }).loose()).max(10_000),
}).loose();

export function parsePlanQueue(text: string): Result<Queue> {
  const json = parseJson(text);
  if (!json.ok) return bad("malformed", "plan-queue.json was not valid JSON");
  const parsed = RawQueue.safeParse(json.value);
  if (!parsed.success) return bad("malformed", "plan-queue.json had an unexpected shape");
  const entries = parsed.data.entries;
  return {
    ok: true,
    data: {
      present: true,
      size: entries.length,
      names: entries.slice(0, 20).map((entry) => clean(entry.task ? `${entry.name}/${entry.task}` : entry.name, 120)),
    },
  };
}

// ----------------------------------------------------------------- reports

// meute's lib/report.py: FINDING_RE = ^###\s+\[(CRITICAL|HIGH|MEDIUM|LOW)\]\s*(.*)$ with re.M, on
// str. Python semantics, reproduced exactly (tests/numbering-diff.test.ts checks against Python):
//  - ^ matches only at the start or right after "\n" (JS's m flag also matches after U+2028/2029);
//  - . is [^\n] (JS's . also stops at \r, U+2028, U+2029);
//  - \s is Python's str.isspace() set (generated with python3 -I), which includes \n, \x1c-\x1f,
//    \x85 and U+00A0 and excludes U+FEFF, so \s+ and \s* can run across line ends.
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LINE_START = "(?<![^\\n])";
const FINDING_HEADING = new RegExp(`${LINE_START}###[${PY_SPACE}]+\\[(CRITICAL|HIGH|MEDIUM|LOW)\\][${PY_SPACE}]*([^\\n]*)`, "g");
const SECTION_HEADING = new RegExp(`${LINE_START}## `);
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");
/** Python's str.strip() with no argument. */
const pyStrip = (value: string): string => value.replace(PY_STRIP, "");
export const MAX_EXCERPT_CHARS = 16_000;

/** Mirrors lib/report.py split_report + lib/inbox.py finding_body, without marking anything read. */
export function extractFindingExcerpt(rawText: string, n: number): Result<FindingDetail> {
  if (!Number.isSafeInteger(n) || n < 1) return bad("invalid_input", "Invalid finding number");
  const text = rawText.replace(/\r\n?/g, "\n");
  let body = text;
  if (text.startsWith("---\n")) {
    const end = text.indexOf("\n---\n", 4);
    if (end !== -1) body = text.slice(end + 5);
  }
  const heads = [...body.matchAll(FINDING_HEADING)];
  const head = heads[n - 1];
  if (!head || head.index === undefined) return bad("not_found", "No such finding in the report");
  const next = heads[n];
  let chunk = body.slice(head.index, next?.index ?? body.length);
  const firstNewline = chunk.indexOf("\n");
  if (firstNewline >= 0) {
    const section = SECTION_HEADING.exec(chunk.slice(firstNewline + 1));
    if (section) chunk = chunk.slice(0, firstNewline + 1 + section.index);
  }
  const cleaned = sanitizeText(chunk.trimEnd(), Number.MAX_SAFE_INTEGER);
  const truncated = cleaned.length > MAX_EXCERPT_CHARS;
  return {
    ok: true,
    data: {
      id: "",
      severity: head[1] ?? "",
      title: sanitizeText(pyStrip(head[2] ?? ""), 300),
      excerpt: truncated ? cleaned.slice(0, MAX_EXCERPT_CHARS) : cleaned,
      truncated,
    },
  };
}

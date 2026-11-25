// Pure view-model functions: no React, no host imports, unit-tested.
import type {
  ApiError, Finding, HealthData, LogEntry, ReadinessData, RunStatusData,
} from "../shared/contracts";
import { isSafeName } from "../shared/validate";

export type Tone = "success" | "warning" | "danger" | "muted";

// ------------------------------------------------------------------ findings

const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

export function severityRank(severity: string): number {
  const index = SEVERITY_ORDER.indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

export type StateGroup = "new" | "open" | "dismissed" | "closed";

/** Unknown states stay visible as "open": a new meute state must not hide a finding. */
export function findingStateGroup(state: string): StateGroup {
  if (state === "new") return "new";
  if (state === "dismissed") return "dismissed";
  if (["actioned", "resolved", "gone", "superseded", "closed"].includes(state)) return "closed";
  return "open";
}

export interface Filters {
  readonly state: "all" | "new" | "open" | "dismissed";
  readonly repo: string;
  /** Repo picker: empty or absent means every repo. */
  readonly repos?: readonly string[];
  readonly severity: string;
}

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export function filterFindings(findings: readonly Finding[], filters: Filters): Finding[] {
  return findings.filter((finding) => {
    const group = findingStateGroup(finding.state);
    if (filters.state === "new" && group !== "new") return false;
    if (filters.state === "open" && group !== "new" && group !== "open") return false;
    if (filters.state === "dismissed" && group !== "dismissed") return false;
    if (filters.repo !== "" && finding.repo !== filters.repo) return false;
    if (filters.repos !== undefined && filters.repos.length > 0 && !filters.repos.includes(finding.repo)) return false;
    if (filters.severity !== "" && finding.severity !== filters.severity) return false;
    return true;
  });
}

export function repoOptions(findings: readonly Finding[]): string[] {
  return [...new Set(findings.map((finding) => finding.repo))].sort();
}

export const MAX_PICKED_REPOS = 64;
const MAX_STORED_REPOS_CHARS = 8192;

/** Picker options: each repo once, sorted, and only names that are safe path segments. */
export function pickerRepos(findings: readonly Finding[]): string[] {
  return repoOptions(findings).filter((repo) => isSafeName(repo));
}

export function toggleRepo(selected: readonly string[], repo: string): string[] {
  return selected.includes(repo) ? selected.filter((entry) => entry !== repo) : [...selected, repo];
}

/** A remembered choice may name repos that no longer exist; those are ignored (empty means all). */
export function effectiveRepos(selected: readonly string[], available: readonly string[]): string[] {
  return selected.filter((repo) => available.includes(repo));
}

/** Stored text is untrusted: only a bounded JSON array of safe, unique names is accepted. */
export function parseStoredRepos(raw: string | null): string[] {
  if (raw === null || raw.length > MAX_STORED_REPOS_CHARS) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const names = value.filter((entry): entry is string => isSafeName(entry));
  return [...new Set(names)].sort().slice(0, MAX_PICKED_REPOS);
}

export const SEVERITY_FILTERS = SEVERITY_ORDER;

export function severityTone(severity: string): Tone {
  if (severity === "CRITICAL" || severity === "HIGH") return "danger";
  if (severity === "MEDIUM") return "warning";
  return "muted";
}

// ------------------------------------------------------------------- polling

export const STALE_DROP_MS = 5 * 60 * 1000;
export const MAX_BACKOFF_MS = 120_000;

export interface PollState<D> {
  readonly data?: D;
  readonly observedAt?: string;
  readonly lastOkAt?: number;
  readonly staleSince?: number;
  readonly error?: ApiError;
  readonly failures: number;
  /** Set when polling (re)starts, e.g. on resume from background: the data predates this session. */
  readonly resumed?: boolean;
}

export const INITIAL_POLL: PollState<never> = { failures: 0 };

export type PollOutcome<D> =
  | { ok: true; data: D; observedAt: string }
  | { ok: false; error: ApiError };

export function nextDelayMs(baseMs: number, failures: number): number {
  const count = Number.isFinite(failures) && failures > 0 ? Math.floor(failures) : 0;
  return Math.min(MAX_BACKOFF_MS, baseMs * 2 ** Math.min(count, 20));
}

/** Old data is kept only briefly after a failure, and always flagged stale. */
export function reducePoll<D>(previous: PollState<D>, outcome: PollOutcome<D>, now: number): PollState<D> {
  if (outcome.ok) {
    return { data: outcome.data, observedAt: outcome.observedAt, lastOkAt: now, failures: 0 };
  }
  const failures = previous.failures + 1;
  const lastOkAt = previous.lastOkAt;
  const expired = lastOkAt === undefined || now - lastOkAt > STALE_DROP_MS;
  if (expired || previous.data === undefined) {
    return { error: outcome.error, failures, ...(lastOkAt !== undefined ? { lastOkAt } : {}) };
  }
  return {
    data: previous.data,
    ...(previous.observedAt !== undefined ? { observedAt: previous.observedAt } : {}),
    lastOkAt,
    staleSince: previous.staleSince ?? lastOkAt,
    error: outcome.error,
    failures,
  };
}

/** Polling (re)started: whatever data is held is old until the next answer arrives. */
export function markResumed<D>(state: PollState<D>): PollState<D> {
  return state.data === undefined ? state : { ...state, resumed: true };
}

export interface Freshness {
  /** True whenever the data may not be current: an error, an age above 2x the poll period, or a resume. */
  readonly stale: boolean;
  readonly label: string | null;
  readonly asOf: string | null;
}

/** Answers older than this many poll periods are stale even if no call has failed yet. */
export const STALE_AFTER_PERIODS = 2;

export function freshness(state: PollState<unknown>, now: number, baseMs: number | null): Freshness {
  const asOf = state.data !== undefined && state.lastOkAt !== undefined ? `as of ${formatAsOf(state.lastOkAt, now)}` : null;
  const label = staleLabel(state);
  if (label !== null) return { stale: true, label, asOf };
  if (state.data === undefined) return { stale: false, label: null, asOf };
  const aged = baseMs !== null && state.lastOkAt !== undefined && now - state.lastOkAt > STALE_AFTER_PERIODS * baseMs;
  if (aged || state.resumed === true) {
    return { stale: true, label: `Stale: last answer ${asOf ?? "at an unknown time"}, checking again`, asOf };
  }
  return { stale: false, label: null, asOf };
}

/** HH:MM today, MM-DD HH:MM on another day. */
function formatAsOf(at: number, now: number): string {
  const day = (value: number) => new Date(value).toDateString();
  return day(at) === day(now) ? formatClock(at) : formatDateTime(new Date(at).toISOString());
}

export function formatClock(value: string | number | undefined): string {
  if (value === undefined) return "?";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "?";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function staleLabel(state: PollState<unknown>): string | null {
  if (state.error === undefined) return null;
  if (state.data === undefined) return "Unavailable";
  return `Stale since ${formatClock(state.staleSince)}`;
}

// ----------------------------------------------------------------- readiness

export interface ReadinessRow {
  readonly label: string;
  readonly status: string;
  readonly reason: string;
  readonly detail?: string;
  readonly tone: Tone;
}
export interface ReadinessView {
  readonly headline: string;
  readonly tone: Tone;
  readonly summary: string;
  readonly rows: ReadinessRow[];
}

const checkTone = (status: string): Tone => (status === "passed" ? "success" : status === "pending" ? "warning" : "danger");

export function readinessView(data: ReadinessData): ReadinessView {
  const rows = data.checks.map((check): ReadinessRow => ({
    label: check.purpose ? `${check.check} (${check.purpose})` : check.check,
    status: check.status,
    reason: check.reason,
    ...(check.detail ? { detail: check.detail } : {}),
    tone: checkTone(check.status),
  }));
  const outstanding = rows.filter((row) => row.status !== "passed");
  const ordered = [...outstanding, ...rows.filter((row) => row.status === "passed")];
  const consistent = data.verdict === "ready" ? data.exitCode === 0 && outstanding.length === 0 : true;
  if (data.verdict === "ready" && rows.length === 0) {
    return { headline: "UNKNOWN: no checks reported, treat as NOT READY", tone: "danger", summary: "Meute reported ready without any check", rows };
  }
  if (data.verdict === "ready" && consistent) {
    return { headline: "READY", tone: "success", summary: `All ${rows.length} checks passed`, rows: ordered };
  }
  if (data.verdict === "pending") {
    return {
      headline: "NOT READY: pending",
      tone: "warning",
      summary: `${outstanding.length} of ${rows.length} checks outstanding`,
      rows: ordered,
    };
  }
  return {
    headline: data.verdict === "invalid" ? "NOT READY: invalid input" : "NOT READY: inconsistent result",
    tone: "danger",
    summary: `${outstanding.length} of ${rows.length} checks not passed`,
    rows: ordered,
  };
}

export function unavailableView(_kind: "readiness", error: ApiError): ReadinessView {
  return {
    headline: error.code === "not_configured" ? "NOT CONFIGURED: treat as NOT READY" : "UNKNOWN: treat as NOT READY",
    tone: "danger",
    summary: error.message,
    rows: [],
  };
}

/**
 * What the readiness section shows. Fail closed: an error is UNKNOWN (the last answer only as
 * dimmed history), and a READY that is not current (aged or resumed) loses the success colour.
 */
export function readinessDisplay(state: PollState<ReadinessData>, now: number, baseMs: number | null): {
  current: ReadinessView | null;
  lastKnown: ReadinessView | null;
  fresh: Freshness;
} {
  const fresh = freshness(state, now, baseMs);
  if (state.error) {
    return { current: unavailableView("readiness", state.error), lastKnown: state.data ? readinessView(state.data) : null, fresh };
  }
  if (!state.data) return { current: null, lastKnown: null, fresh };
  const view = readinessView(state.data);
  if (fresh.stale && view.tone === "success") {
    return { current: { ...view, headline: "Last answer READY, not current: treat as NOT READY", tone: "muted" }, lastKnown: null, fresh };
  }
  return { current: view, lastKnown: null, fresh };
}

// -------------------------------------------------------------------- health

export function healthView(data: HealthData): { headline: string; tone: Tone; lines: string[] } {
  if (data.state === "healthy") return { headline: "Healthy", tone: "success", lines: [] };
  if (data.state === "unhealthy") return { headline: "Unhealthy", tone: "danger", lines: data.problems };
  return { headline: "Unknown", tone: "warning", lines: data.problems };
}

// ----------------------------------------------------------------------- run

export interface TextTone {
  readonly text: string;
  readonly tone: Tone;
}

function lockView(lock: RunStatusData["lock"]): TextTone {
  if (!lock.ok) return { text: `Lock status unavailable: ${lock.error.message}`, tone: "danger" };
  if (lock.data.state === "none") return { text: "No run holds the lock", tone: "success" };
  const { pid, alive, slot, key, startedAt } = lock.data;
  const who = `${slot} ${key} (pid ${pid ?? "unknown"})`;
  if (alive === true) return { text: `Run in progress: ${who}, started ${formatDateTime(startedAt)}`, tone: "warning" };
  if (alive === false) return { text: `lock-info names pid ${pid}, which is not running: possibly stale (${slot} ${key})`, tone: "warning" };
  return { text: `lock-info present for ${slot} ${key}; the holder could not be verified`, tone: "warning" };
}

function queueView(queue: RunStatusData["queue"]): TextTone {
  if (!queue.ok) return { text: `Queue unavailable: ${queue.error.message}`, tone: "danger" };
  if (!queue.data.present) return { text: "No staged plan queue", tone: "muted" };
  return { text: `${queue.data.size} queued`, tone: queue.data.size > 0 ? "warning" : "muted" };
}

function logTone(status: string | undefined): Tone {
  if (status === "ok") return "success";
  if (status === "error") return "danger";
  return "muted";
}

function logLine(entry: LogEntry): TextTone {
  const { status, repo, task, code, dur } = entry.fields;
  const subject = repo ? `${repo}${task ? `/${task}` : ""}` : "-";
  const text = [formatDateTime(entry.time), status ?? "?", subject, code, dur].filter(Boolean).join(" ");
  return { text, tone: logTone(status) };
}

export function runView(data: RunStatusData): {
  lock: TextTone;
  queue: TextTone;
  logLines: TextTone[];
  logNote: string | null;
} {
  return {
    lock: lockView(data.lock),
    queue: queueView(data.queue),
    logLines: data.log.ok ? [...data.log.data.entries].reverse().map(logLine) : [],
    logNote: data.log.ok ? null : `Log unavailable: ${data.log.error.message}`,
  };
}

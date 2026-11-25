import { describe, expect, it } from "vitest";
import {
  filterFindings, findingStateGroup, healthView, INITIAL_POLL, nextDelayMs, readinessView,
  reducePoll, repoOptions, runView, severityRank, sortFindings, STALE_DROP_MS, staleLabel,
  unavailableView, type Filters,
} from "../client/viewmodel";
import type { Finding, ReadinessData, RunStatusData } from "../shared/contracts";

const f = (over: Partial<Finding>): Finding => ({
  id: "r/a#1", report: "r/a", n: 1, repo: "r", severity: "LOW", title: "t", location: "", state: "new",
  inherited: "", verdict: "", pr: "", ...over,
});
const ALL: Filters = { state: "all", repo: "", severity: "" };

describe("findings view model", () => {
  const list = [
    f({ id: "b/x#1", repo: "b", severity: "LOW", state: "new" }),
    f({ id: "a/x#2", repo: "a", severity: "CRITICAL", state: "dismissed" }),
    f({ id: "a/x#1", repo: "a", severity: "HIGH", state: "read" }),
    f({ id: "b/y#1", repo: "b", severity: "MEDIUM", state: "claimed" }),
    f({ id: "c/z#1", repo: "c", severity: "HIGH", state: "actioned" }),
    f({ id: "c/z#2", repo: "c", severity: "WEIRD", state: "mystery" }),
  ];

  it("ranks severities, unknown last", () => {
    expect(["LOW", "CRITICAL", "WEIRD", "HIGH", "MEDIUM"].sort((a, b) => severityRank(a) - severityRank(b))).toEqual(["CRITICAL", "HIGH", "MEDIUM", "LOW", "WEIRD"]);
  });

  it("sorts by severity then id without mutating the input", () => {
    const before = [...list];
    expect(sortFindings(list).map((x) => x.id)).toEqual(["a/x#2", "a/x#1", "c/z#1", "b/y#1", "b/x#1", "c/z#2"]);
    expect(list).toEqual(before);
  });

  it("groups states: new / open / dismissed / closed, unknown stays visible as open", () => {
    expect(["new", "read", "claimed", "mystery", "dismissed", "actioned", "resolved", "gone", "superseded"].map(findingStateGroup))
      .toEqual(["new", "open", "open", "open", "dismissed", "closed", "closed", "closed", "closed"]);
  });

  it("filters by state group, repo and severity", () => {
    const ids = (filters: Filters) => filterFindings(list, filters).map((x) => x.id).sort();
    expect(ids(ALL)).toHaveLength(6);
    expect(ids({ ...ALL, state: "new" })).toEqual(["b/x#1"]);
    expect(ids({ ...ALL, state: "open" })).toEqual(["a/x#1", "b/x#1", "b/y#1", "c/z#2"]);
    expect(ids({ ...ALL, state: "dismissed" })).toEqual(["a/x#2"]);
    expect(ids({ ...ALL, repo: "a" })).toEqual(["a/x#1", "a/x#2"]);
    expect(ids({ ...ALL, severity: "HIGH" })).toEqual(["a/x#1", "c/z#1"]);
    expect(ids({ state: "open", repo: "b", severity: "LOW" })).toEqual(["b/x#1"]);
  });

  it("lists repos once, sorted", () => {
    expect(repoOptions(list)).toEqual(["a", "b", "c"]);
  });
});

describe("polling state", () => {
  const T0 = 1_000_000;
  const ok = { ok: true as const, data: { x: 1 }, observedAt: "2026-11-25T10:00:00.000Z" };
  const err = { ok: false as const, error: { code: "timeout" as const, message: "Meute did not answer in time" } };

  it("backs off exponentially up to a cap", () => {
    expect([0, 1, 2, 3, 4, 10].map((n) => nextDelayMs(10_000, n))).toEqual([10_000, 20_000, 40_000, 80_000, 120_000, 120_000]);
    expect(nextDelayMs(10_000, -1)).toBe(10_000);
    expect(nextDelayMs(10_000, Number.NaN)).toBe(10_000);
  });

  it("a success resets failures and clears staleness", () => {
    const failed = reducePoll(reducePoll(INITIAL_POLL, ok, T0), err, T0 + 1000);
    expect(failed.failures).toBe(1);
    const recovered = reducePoll(failed, ok, T0 + 2000);
    expect(recovered).toMatchObject({ failures: 0, data: { x: 1 } });
    expect(recovered.staleSince).toBeUndefined();
    expect(recovered.error).toBeUndefined();
  });

  it("a failure keeps old data but marks it stale since the last good read", () => {
    const first = reducePoll(INITIAL_POLL, ok, T0);
    const failed = reducePoll(first, err, T0 + 5000);
    expect(failed).toMatchObject({ data: { x: 1 }, staleSince: T0, error: { code: "timeout" }, failures: 1 });
    expect(reducePoll(failed, err, T0 + 9000).staleSince).toBe(T0);
  });

  it("drops data entirely after a long outage", () => {
    const first = reducePoll(INITIAL_POLL, ok, T0);
    const long = reducePoll(first, err, T0 + STALE_DROP_MS + 1);
    expect(long.data).toBeUndefined();
    expect(long.error).toBeDefined();
  });

  it("never shows data when the very first call fails", () => {
    const first = reducePoll(INITIAL_POLL, err, T0);
    expect(first.data).toBeUndefined();
    expect(first.error).toMatchObject({ code: "timeout" });
  });

  it("labels staleness with a clock time and says unavailable when there is no data", () => {
    const first = reducePoll(INITIAL_POLL, ok, T0);
    const failed = reducePoll(first, err, T0 + 5000);
    expect(staleLabel(failed)).toMatch(/^Stale since \d{2}:\d{2}/);
    expect(staleLabel(first)).toBeNull();
    expect(staleLabel(reducePoll(INITIAL_POLL, err, T0))).toBe("Unavailable");
    expect(staleLabel(INITIAL_POLL)).toBeNull();
  });
});

describe("readiness wording is fail-closed", () => {
  const base: ReadinessData = { verdict: "ready", exitCode: 0, version: 1, checks: [
    { check: "input", status: "passed", reason: "input_valid" },
    { check: "evidence", status: "passed", reason: "ok", purpose: "docs" },
  ] };

  it("ready needs exit 0, verdict ready and every check passed", () => {
    expect(readinessView(base)).toMatchObject({ tone: "success", headline: "READY" });
  });

  it("pending is NOT READY and lists outstanding checks first", () => {
    const view = readinessView({ ...base, verdict: "pending", exitCode: 1, checks: [
      { check: "input", status: "passed", reason: "input_valid" },
      { check: "evidence", status: "pending", reason: "evidence_missing", purpose: "docs" },
    ] });
    expect(view.headline).toBe("NOT READY: pending");
    expect(view.tone).toBe("warning");
    expect(view.rows[0]).toMatchObject({ label: "evidence (docs)", status: "pending", tone: "warning" });
    expect(view.summary).toMatch(/1 of 2 checks outstanding/);
  });

  it("invalid is NOT READY and danger", () => {
    expect(readinessView({ ...base, verdict: "invalid", exitCode: 2, checks: [{ check: "input", status: "invalid", reason: "policy_unreadable" }] }))
      .toMatchObject({ headline: "NOT READY: invalid input", tone: "danger" });
  });

  it("a ready verdict with a non-passed check is never shown as ready", () => {
    const view = readinessView({ ...base, checks: [{ check: "x", status: "failed", reason: "r" }] });
    expect(view.headline).not.toBe("READY");
    expect(view.tone).not.toBe("success");
  });

  it("an unavailable answer says unknown and not ready", () => {
    expect(unavailableView("readiness", { code: "timeout", message: "x" })).toMatchObject({ headline: "UNKNOWN: treat as NOT READY", tone: "danger" });
    expect(unavailableView("readiness", { code: "not_configured", message: "x" }).headline).toBe("NOT CONFIGURED: treat as NOT READY");
  });
});

describe("health and run views", () => {
  it("health: only the healthy state is success", () => {
    expect(healthView({ state: "healthy", problems: [] })).toMatchObject({ headline: "Healthy", tone: "success" });
    expect(healthView({ state: "unhealthy", problems: ["a"] })).toMatchObject({ headline: "Unhealthy", tone: "danger" });
    expect(healthView({ state: "unknown", problems: ["b"] })).toMatchObject({ headline: "Unknown", tone: "warning" });
  });

  const run = (over: Partial<RunStatusData>): RunStatusData => ({
    lock: { ok: true, data: { state: "none" } },
    log: { ok: true, data: { size: 10, partial: false, entries: [] } },
    queue: { ok: true, data: { present: true, size: 3, names: ["a/b"] } },
    ...over,
  });

  it("describes the lock holder from lock-info as a hint", () => {
    expect(runView(run({})).lock).toMatchObject({ text: "No run holds the lock", tone: "success" });
    const live = runView(run({ lock: { ok: true, data: { state: "info", pid: 4242, alive: true, startedAt: "2026-11-24T03:17:00+00:00", slot: "daily", key: "sample/audit" } } }));
    expect(live.lock.text).toMatch(/daily.*sample\/audit.*pid 4242/);
    const stale = runView(run({ lock: { ok: true, data: { state: "info", pid: 4242, alive: false, startedAt: "x", slot: "daily", key: "-" } } }));
    expect(stale.lock).toMatchObject({ tone: "warning" });
    expect(stale.lock.text).toMatch(/not running/i);
    const unknown = runView(run({ lock: { ok: true, data: { state: "info", pid: null, alive: null, startedAt: "x", slot: "daily", key: "-" } } }));
    expect(unknown.lock.tone).toBe("warning");
  });

  it("summarises the queue and the newest log lines first", () => {
    const view = runView(run({ log: { ok: true, data: { size: 9, partial: false, entries: [
      { time: "2026-11-23T03:17:02+00:00", fields: { status: "ok", repo: "sample", task: "audit", code: "ok", dur: "412s" } },
      { time: "2026-11-24T03:17:01+00:00", fields: { status: "error", repo: "other", task: "audit", code: "failed", dur: "9s" } },
    ] } } }));
    expect(view.queue.text).toBe("3 queued");
    expect(view.logLines).toHaveLength(2);
    expect(view.logLines[0]).toMatchObject({ tone: "danger" });
    expect(view.logLines[0]?.text).toContain("other/audit");
  });

  it("shows section errors instead of values", () => {
    const view = runView(run({ queue: { ok: false, error: { code: "malformed", message: "bad" } } }));
    expect(view.queue).toMatchObject({ text: "Queue unavailable: bad", tone: "danger" });
  });
});

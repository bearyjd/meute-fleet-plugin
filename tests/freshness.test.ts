// Stale by AGE, not only after a failed call (review 06 paseo F2), and readiness fails closed on
// zero checks (tests C1) and when stale.
import { describe, expect, it } from "vitest";
import type { ReadinessData } from "../shared/contracts";
import {
  freshness, INITIAL_POLL, markResumed, readinessDisplay, readinessView, reducePoll, type PollState,
} from "../client/viewmodel";

const T0 = new Date(2026, 10, 25, 9, 30).getTime();
const BASE = 60_000;
const ok = <D>(data: D) => ({ ok: true as const, data, observedAt: new Date(T0).toISOString() });
const fresh = <D>(data: D): PollState<D> => reducePoll(INITIAL_POLL as PollState<D>, ok(data), T0);
const READY: ReadinessData = { verdict: "ready", exitCode: 0, version: 1, checks: [{ check: "a", status: "passed", reason: "ok" }] };

describe("freshness by age", () => {
  it("a recent answer is current and says as of when", () => {
    expect(freshness(fresh("x"), T0 + BASE, BASE)).toEqual({ stale: false, label: null, asOf: "as of 09:30" });
  });

  it("an answer older than 2x the poll period is stale even with no error", () => {
    const view = freshness(fresh("x"), T0 + 2 * BASE + 1, BASE);
    expect(view.stale).toBe(true);
    expect(view.label).toMatch(/^Stale: last answer as of 09:30/);
    expect(freshness(fresh("x"), T0 + 2 * BASE, BASE).stale).toBe(false);
  });

  it("a resumed state is stale until the new answer arrives, then current again", () => {
    const resumed = markResumed(fresh("x"));
    expect(freshness(resumed, T0 + 1000, BASE).stale).toBe(true);
    const answered = reducePoll(resumed, ok("y"), T0 + 2000);
    expect(freshness(answered, T0 + 2000, BASE).stale).toBe(false);
    expect(markResumed(INITIAL_POLL)).toEqual(INITIAL_POLL);
  });

  it("an answer from another day shows the date", () => {
    expect(freshness(fresh("x"), T0 + 86_400_000, null).asOf).toBe("as of 11-25 09:30");
  });

  it("a failure is stale and keeps its labels", () => {
    const failed = reducePoll(fresh("x"), { ok: false, error: { code: "timeout", message: "m" } }, T0 + 1000);
    expect(freshness(failed, T0 + 1000, BASE)).toMatchObject({ stale: true, label: "Stale since 09:30" });
    expect(freshness(reducePoll(INITIAL_POLL, { ok: false, error: { code: "timeout", message: "m" } }, T0), T0, BASE))
      .toMatchObject({ stale: true, label: "Unavailable", asOf: null });
  });

  it("one-shot fetches (no poll period) are not aged", () => {
    expect(freshness(fresh("x"), T0 + 3_600_000, null).stale).toBe(false);
  });
});

describe("readiness never shows READY in the success colour unless current", () => {
  it("current READY is success", () => {
    expect(readinessDisplay(fresh(READY), T0 + 1000, BASE).current).toMatchObject({ headline: "READY", tone: "success" });
  });

  it("READY older than 2x the poll period is not success and says treat as NOT READY", () => {
    const view = readinessDisplay(fresh(READY), T0 + 2 * BASE + 1, BASE).current;
    expect(view?.tone).not.toBe("success");
    expect(view?.headline).toMatch(/treat as NOT READY/);
  });

  it("READY after resume, before the new answer, is not success", () => {
    expect(readinessDisplay(markResumed(fresh(READY)), T0 + 1000, BASE).current?.tone).not.toBe("success");
  });

  it("an error is UNKNOWN, with the last answer only as dimmed history", () => {
    const failed = reducePoll(fresh(READY), { ok: false, error: { code: "timeout", message: "m" } }, T0 + 1000);
    const display = readinessDisplay(failed, T0 + 1000, BASE);
    expect(display.current).toMatchObject({ headline: "UNKNOWN: treat as NOT READY", tone: "danger" });
    expect(display.lastKnown?.headline).toBe("READY");
  });
});

describe("readiness with zero checks is never READY (tests C1)", () => {
  it("view: ready with no checks is unknown, not 'All 0 checks passed'", () => {
    const view = readinessView({ ...READY, checks: [] });
    expect(view.headline).not.toBe("READY");
    expect(view.tone).not.toBe("success");
    expect(view.summary).not.toMatch(/All 0/);
    expect(view.headline).toMatch(/no checks reported/i);
  });

  it("view: ready with a non-zero exit code is not READY (tests VM1)", () => {
    expect(readinessView({ ...READY, exitCode: 1 }).headline).not.toBe("READY");
  });
});

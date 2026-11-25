// Host paths are redacted in every field that leaves the daemon (review 06 tests P4/P5/P6, C2,
// runner F10), and run-status read errors surface as section errors (tests F1/F2/X5).
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runView } from "../client/viewmodel";
import { readiness, runStatus } from "../server/fleet";
import { parseLockInfo, parseLogLine, parseReadiness } from "../server/parsers";
import { makeFixtureRoot, type FixtureRoot } from "./helpers";

let box: FixtureRoot | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
});

describe("redaction", () => {
  it("lock-info: key, startedAt and slot", () => {
    const result = parseLockInfo("pid=99999 started=/home/op/secret slot=/home/op/x key=/home/op/k");
    expect(result).toMatchObject({ ok: true, data: { startedAt: "<path>", slot: "<path>", key: "<path>" } });
  });

  it("log fields", () => {
    const entry = parseLogLine("2026-11-25T09:00:00Z\tstatus=error\tpr=/home/op/x/pr.json\trepo=r\tcode=at /srv/meute/state");
    expect(entry?.fields).toMatchObject({ pr: "<path>", repo: "r", code: "at <path>" });
  });

  it("a known root is replaced only at a path boundary, together with the rest of the path", () => {
    expect(parseReadiness(1, JSON.stringify({ version: 1, status: "pending", checks: [{ check: "c", status: "pending", reason: "r",
      detail: "/r/state/x and /rx/y and /r" }] }), "/r")).toMatchObject({ ok: true, data: { checks: [{ detail: "<path> and <path> and <path>" }] } });
  });

  it("readiness scope values", () => {
    const raw = JSON.stringify({ version: 1, status: "pending", checks: [{ check: "c", status: "pending", reason: "r" }],
      scope: { record: "/home/op/records/rec.json", repo: "sample" } });
    expect(parseReadiness(1, raw, "/r")).toMatchObject({ ok: true, data: { scope: { record: "<path>", repo: "sample" } } });
  });

  it("configured paths with spaces are redacted whole (record, policy, HOME)", async () => {
    box = makeFixtureRoot();
    const record = "/home/op/my records/record-pending.json";
    writeFileSync(box.meute, `#!/bin/bash
printf '%s' '{"version":1,"status":"pending","checks":[{"check":"c","status":"pending","reason":"r","detail":"read ${record} and /run/op/my run/x"}]}'
exit 1
`);
    const result = await readiness({ ...box.config, readinessRecordPath: record, xdgRuntimeDir: "/run/op/my run" });
    const text = JSON.stringify(result);
    expect(text).toMatch(/read <path> and <path>/);
    expect(text).not.toMatch(/records|record-pending|run\/x|\bmy\b|\/home|\/run/);
  });
});

describe("run status read errors are section errors, never 'no run' or 'empty log'", () => {
  it.each([
    ["a symlinked lock-info", (b: FixtureRoot) => {
      rmSync(join(b.root, "state/lock-info"));
      symlinkSync(join(b.dir, "elsewhere"), join(b.root, "state/lock-info"));
    }, "unsafe_path"],
    ["an oversize lock-info", (b: FixtureRoot) => writeFileSync(join(b.root, "state/lock-info"), `pid=1 ${"x".repeat(5000)}`), "too_large"],
    ["a directory as lock-info", (b: FixtureRoot) => {
      rmSync(join(b.root, "state/lock-info"));
      mkdirSync(join(b.root, "state/lock-info"));
    }, "unsafe_path"],
  ])("lock: %s", async (_label, spoil, code) => {
    box = makeFixtureRoot();
    spoil(box);
    const result = await runStatus(box.config, { lines: 5 });
    expect(result.ok && result.data.lock).toMatchObject({ ok: false, error: { code } });
    if (result.ok) {
      expect(runView(result.data).lock.text).not.toMatch(/No run holds the lock/);
      expect(runView(result.data).lock.tone).toBe("danger");
    }
  });

  it.each([["", "empty"], ["garbage without fields", "garbage"]])("lock-info %j is malformed, not 'no run'", async (text) => {
    box = makeFixtureRoot();
    writeFileSync(join(box.root, "state/lock-info"), text);
    const result = await runStatus(box.config, { lines: 5 });
    expect(result.ok && result.data.lock).toMatchObject({ ok: false, error: { code: "malformed" } });
  });

  it.each([
    ["a symlinked log", (b: FixtureRoot) => {
      rmSync(join(b.root, "state/log"));
      symlinkSync(join(b.dir, "elsewhere"), join(b.root, "state/log"));
    }, "unsafe_path"],
    ["a directory as log", (b: FixtureRoot) => {
      rmSync(join(b.root, "state/log"));
      mkdirSync(join(b.root, "state/log"));
    }, "unsafe_path"],
  ])("log: %s", async (_label, spoil, code) => {
    box = makeFixtureRoot();
    spoil(box);
    const result = await runStatus(box.config, { lines: 5 });
    expect(result.ok && result.data.log).toMatchObject({ ok: false, error: { code } });
    if (result.ok) expect(runView(result.data).logNote).toMatch(/^Log unavailable/);
  });
});

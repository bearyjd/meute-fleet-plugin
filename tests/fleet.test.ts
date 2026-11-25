import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../server/config";
import { getFinding, health, listFindings, readiness, runStatus } from "../server/fleet";
import { makeFixtureRoot, type FixtureRoot } from "./helpers";

let box: FixtureRoot | undefined;
const made: FixtureRoot[] = [];
const make = () => {
  box = makeFixtureRoot();
  made.push(box);
  return box;
};
afterEach(() => {
  for (const each of made.splice(0)) each.cleanup(); // every sandbox, not only the last one
  box = undefined;
});

describe("listFindings", () => {
  it("returns the findings parsed from the captured meute output", async () => {
    const result = await listFindings(make().config);
    expect(result.ok && result.data.findings.map((f) => f.id).sort()).toEqual([
      "other/audit-2026-11-21#1", "other/audit-2026-11-21#2", "sample/audit-2026-11-20#1", "sample/audit-2026-11-20#2",
    ]);
    expect(box?.calls()).toEqual(["findings --all --json"]);
  });

  it("maps a failing meute to a structured error without leaking paths", async () => {
    make();
    writeFileSync(box!.meute, '#!/bin/bash\necho "fail at $MEUTE_ROOT" >&2\nexit 1\n');
    const result = await listFindings(box!.config);
    expect(result).toMatchObject({ ok: false, error: { code: "exit_nonzero" } });
    expect(JSON.stringify(result)).not.toContain(box!.dir);
  });

  it("maps garbage output to malformed", async () => {
    make();
    writeFileSync(box!.meute, "#!/bin/bash\necho '{oops'\n");
    expect(await listFindings(box!.config)).toMatchObject({ ok: false, error: { code: "malformed" } });
  });
});

describe("getFinding (reads the report file, never `meute show`)", () => {
  it("returns the excerpt and spawns nothing", async () => {
    const result = await getFinding(make().config, { id: "sample/audit-2026-11-20#1" });
    expect(result).toMatchObject({ ok: true, data: { id: "sample/audit-2026-11-20#1", severity: "HIGH" } });
    expect(box?.calls()).toEqual([]);
  });

  it.each([
    "../../etc/passwd#1", "sample/audit-2026-11-20#1; rm -rf /", "--flag", "sample/../x#1", "sample/audit#0",
    "sample/audit#99999999999999999999", "sample/a\0b#1", "sample/a\nb#1", "sample/é#1", `sample/${"a".repeat(500)}#1`,
    "", "#1", "/#1", "a/b/c#1", "sample/audit-2026-11-20#-1", "sample/audit-2026-11-20#1.5", "sample/audit-2026-11-20#１",
    "sample/audit-2026-11-20", "sample\\audit#1", "show sample/audit#1", "sample/.hidden#1",
  ])("refuses id %j", async (id) => {
    const result = await getFinding(make().config, { id });
    expect(result.ok).toBe(false);
    expect(box?.calls()).toEqual([]);
  });

  it("reports unknown finding numbers and missing reports", async () => {
    make();
    expect(await getFinding(box!.config, { id: "sample/audit-2026-11-20#9" })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await getFinding(box!.config, { id: "sample/missing#1" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("refuses a symlinked report that points outside", async () => {
    make();
    writeFileSync(join(box!.dir, "secret.md"), "### [LOW] stolen\n");
    symlinkSync(join(box!.dir, "secret.md"), join(box!.root, "reports/sample/linked.md"));
    const result = await getFinding(box!.config, { id: "sample/linked#1" });
    expect(result).toMatchObject({ ok: false, error: { code: "unsafe_path" } });
    expect(JSON.stringify(result)).not.toContain(box!.dir);
  });
});

describe("readiness", () => {
  const verdictFor = async (name: string) => {
    make();
    return readiness({ ...box!.config, readinessRecordPath: `/records/record-${name}.json` });
  };

  it("ready / pending / invalid come straight from the captured JSON", async () => {
    expect(await verdictFor("ready")).toMatchObject({ ok: true, data: { verdict: "ready" } });
    expect(await verdictFor("pending")).toMatchObject({ ok: true, data: { verdict: "pending" } });
    const invalid = await verdictFor("invalid");
    expect(invalid).toMatchObject({ ok: true, data: { verdict: "invalid" } });
    expect(JSON.stringify(invalid)).not.toContain("/tmp/");
  });

  it("is not_configured without record and policy paths, and spawns nothing", async () => {
    make();
    const result = await readiness({ ...box!.config, readinessRecordPath: undefined });
    expect(result).toMatchObject({ ok: false, error: { code: "not_configured" } });
    expect(box!.calls()).toEqual([]);
  });

  it("passes the configured paths as separate argv entries", async () => {
    make();
    await readiness({ ...box!.config, readinessRecordPath: "/records/my dir/record-ready.json" });
    expect(box!.calls()).toEqual(["readiness validate /records/my dir/record-ready.json --owner-policy /records/policy.json"]);
  });
});

describe("health", () => {
  it("empty output and exit 0 without a visible user bus is unknown (healthy cases: health-signal.test.ts)", async () => {
    expect(await health(make().config)).toMatchObject({ ok: true, data: { state: "unknown" } });
  });
  it("unhealthy: captured real problem lines", async () => {
    make().setMode("unhealthy");
    const result = await health(box!.config);
    expect(result).toMatchObject({ ok: true, data: { state: "unhealthy" } });
  });
  it("a timeout is an error, never healthy", async () => {
    make();
    writeFileSync(box!.meute, "#!/bin/bash\nsleep 30\n");
    const result = await health({ ...box!.config, timeoutMs: 200, graceMs: 100 });
    expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
  });
});

describe("runStatus", () => {
  it("builds run status from files only", async () => {
    const result = await runStatus(make().config, { lines: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.lock).toMatchObject({ ok: true, data: { state: "info", slot: "daily", key: "sample/audit" } });
    expect(result.data.log).toMatchObject({ ok: true, data: { partial: false } });
    expect(result.data.log.ok && result.data.log.data.entries).toHaveLength(2);
    expect(result.data.queue).toMatchObject({ ok: true, data: { present: true, size: 2 } });
    expect(box!.calls()).toEqual([]);
  });

  it("treats missing files as empty and corrupt ones as per-section errors", async () => {
    make();
    const { rmSync } = await import("node:fs");
    rmSync(join(box!.root, "state/lock-info"));
    rmSync(join(box!.root, "state/log"));
    writeFileSync(join(box!.root, "state/plan-queue.json"), "{broken");
    const result = await runStatus(box!.config, { lines: 5 });
    expect(result.ok && result.data.lock).toEqual({ ok: true, data: { state: "none" } });
    expect(result.ok && result.data.log).toMatchObject({ ok: true, data: { entries: [] } });
    expect(result.ok && result.data.queue).toMatchObject({ ok: false, error: { code: "malformed" } });
  });
});

describe("resolveConfig", () => {
  const base = { meutePath: "", meuteRoot: "", readinessRecordPath: "", readinessPolicyPath: "", runnerPath: "", xdgRuntimeDir: "" };

  it("has no defaults: empty settings are not_configured", async () => {
    expect(await resolveConfig(base)).toMatchObject({ ok: false, error: { code: "not_configured" } });
  });

  it("accepts <root>/bin/meute and rejects everything else", async () => {
    make();
    const good = { ...base, meutePath: box!.meute, meuteRoot: box!.root };
    expect(await resolveConfig(good)).toMatchObject({ ok: true });
    for (const bad of [
      { ...good, meutePath: "/usr/bin/true" },
      { ...good, meutePath: `${box!.root}/bin/../bin/meute` },
      { ...good, meuteRoot: "relative" },
      { ...good, meuteRoot: `${box!.root}/` },
      { ...good, runnerPath: "relative:/usr/bin" },
      { ...good, xdgRuntimeDir: "../x" },
    ]) {
      expect(await resolveConfig(bad)).toMatchObject({ ok: false });
    }
  });

  it("refuses a symlinked or non-executable binary", async () => {
    make();
    const { chmodSync, renameSync } = await import("node:fs");
    const good = { ...base, meutePath: box!.meute, meuteRoot: box!.root };
    chmodSync(box!.meute, 0o644);
    expect(await resolveConfig(good)).toMatchObject({ ok: false, error: { code: "invalid_config" } });
    chmodSync(box!.meute, 0o755);
    renameSync(box!.meute, join(box!.dir, "real-meute"));
    symlinkSync(join(box!.dir, "real-meute"), box!.meute);
    expect(await resolveConfig(good)).toMatchObject({ ok: false, error: { code: "invalid_config" } });
    mkdirSync(join(box!.dir, "unused"));
  });
});

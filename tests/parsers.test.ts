import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractFindingExcerpt, parseFindings, parseHealth, parseLockInfo, parseLogLine, parsePlanQueue,
  parseReadiness,
} from "../server/parsers";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const ROOT = "/tmp/some/meute root";

describe("parseFindings (real captured `findings --all --json`)", () => {
  it("parses the real output", () => {
    const result = parseFindings(fixture("captured/findings-all.json"), "");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.findings).toHaveLength(4);
    const critical = result.data.findings.find((f) => f.severity === "CRITICAL");
    expect(critical).toMatchObject({ id: "other/audit-2026-11-21#2", repo: "other", state: "dismissed", n: 2 });
    expect(result.data.findings.find((f) => f.id.startsWith("other/") && f.n === 1)?.title).toBe("Café token compared with == (naïve)");
  });

  it("tolerates unknown fields", () => {
    const raw = JSON.stringify([{ id: "a/b#1", report: "a/b", n: 1, repo: "a", severity: "LOW", title: "t", state: "new", future: { x: 1 } }]);
    expect(parseFindings(raw, "").ok).toBe(true);
  });

  it.each([
    ["not json", "{nope"], ["an object", "{}"], ["a string", '"x"'], ["empty", ""],
    ["wrong types", JSON.stringify([{ id: 5 }])], ["missing fields", JSON.stringify([{ id: "a/b#1" }])],
    ["null item", "[null]"], ["n float", JSON.stringify([{ id: "a/b#1", report: "r", n: 1.5, repo: "a", severity: "L", title: "t", state: "new" }])],
  ])("returns a structured malformed error for %s", (_name, raw) => {
    const result = parseFindings(raw, "");
    expect(result).toMatchObject({ ok: false, error: { code: "malformed" } });
  });

  it("counts skipped reports from stderr and sanitizes text", () => {
    const raw = JSON.stringify([{ id: "a/b#1", report: "a/b", n: 1, repo: "a", severity: "LOW", title: "bad \u001b[31mred\u001b[0m \u0007title", state: "new" }]);
    const result = parseFindings(raw, "meute: skipping reports/x/y.md: unreadable\nmeute: skipping z\nother\n");
    expect(result.ok && result.data.skipped).toBe(2);
    expect(result.ok && result.data.findings[0]?.title).toBe("bad red title");
  });
});

describe("parseReadiness (real captured `readiness validate`)", () => {
  it("ready: exit 0, every check passed", () => {
    const result = parseReadiness(0, fixture("captured/readiness-ready.json"), ROOT);
    expect(result.ok && result.data.verdict).toBe("ready");
    expect(result.ok && result.data.checks.every((c) => c.status === "passed")).toBe(true);
    expect(result.ok && result.data.scope).toMatchObject({ repo: "sample" });
  });

  it("pending: exit 1 and the pending checks are kept", () => {
    const result = parseReadiness(1, fixture("captured/readiness-pending.json"), ROOT);
    expect(result.ok && result.data.verdict).toBe("pending");
    expect(result.ok && result.data.checks.filter((c) => c.status === "pending")).toHaveLength(5);
  });

  it("invalid: exit 2 and the host path in detail is redacted", () => {
    const raw = fixture("captured/readiness-invalid.json");
    expect(raw).toMatch(/\/tmp\//); // the real capture does contain a host path
    const result = parseReadiness(2, raw, ROOT);
    expect(result.ok && result.data.verdict).toBe("invalid");
    expect(JSON.stringify(result)).not.toMatch(/\/tmp\//);
  });

  it("never reports ready when the exit code and the status disagree", () => {
    for (const [code, file] of [[0, "pending"], [0, "invalid"], [1, "ready"], [2, "ready"], [2, "pending"], [1, "invalid"]] as const) {
      const result = parseReadiness(code, fixture(`captured/readiness-${file}.json`), ROOT);
      expect(result.ok).toBe(false);
    }
  });

  it("never reports ready when a check did not pass, even with exit 0 and status ready", () => {
    const body = JSON.parse(fixture("captured/readiness-ready.json"));
    body.checks[3].status = "pending";
    const result = parseReadiness(0, JSON.stringify(body), ROOT);
    expect(result.ok).toBe(false);
  });

  it("never reports ready with zero checks (fail closed: no checks reported is unknown)", () => {
    const result = parseReadiness(0, JSON.stringify({ version: 1, status: "ready", checks: [] }), ROOT);
    expect(result).toMatchObject({ ok: false, error: { code: "malformed" } });
    expect(!result.ok && result.error.message).toMatch(/no checks/);
  });

  it("rejects an unknown version and malformed payloads", () => {
    const body = JSON.parse(fixture("captured/readiness-ready.json"));
    body.version = 2;
    expect(parseReadiness(0, JSON.stringify(body), ROOT)).toMatchObject({ ok: false, error: { code: "unsupported_version" } });
    for (const raw of ["", "nope", "[]", "{}", JSON.stringify({ version: 1 }), JSON.stringify({ version: 1, status: "ready", checks: "x" })]) {
      expect(parseReadiness(0, raw, ROOT)).toMatchObject({ ok: false, error: { code: "malformed" } });
    }
  });

  it("tolerates unknown fields in checks and top level", () => {
    const body = JSON.parse(fixture("captured/readiness-ready.json"));
    body.future = 1;
    body.checks[0].extra = { a: 1 };
    expect(parseReadiness(0, JSON.stringify(body), ROOT).ok).toBe(true);
  });
});

describe("parseHealth", () => {
  it("empty output with exit 0 is healthy", () => {
    expect(parseHealth(0, "", "", ROOT)).toEqual({ ok: true, data: { state: "healthy", problems: [] } });
  });

  it("exit 0 with stderr noise is unknown, never healthy (fail closed)", () => {
    const result = parseHealth(0, "", "lib/timers.sh: line 56: USER: unbound variable\n", ROOT);
    expect(result.ok && result.data.state).toBe("unknown");
  });

  it("real unhealthy output: exit 1 and the problem lines", () => {
    const result = parseHealth(1, fixture("captured/health-unhealthy.txt"), "", ROOT);
    expect(result.ok && result.data.state).toBe("unhealthy");
    expect(result.ok && result.data.problems).toHaveLength(2);
    expect(result.ok && result.data.problems[0]).toMatch(/no run logged/);
  });

  it("exit 1 without any reason, or output with exit 0, are not healthy", () => {
    expect(parseHealth(1, "", "", ROOT)).toMatchObject({ ok: true, data: { state: "unknown" } });
    expect(parseHealth(0, "something is wrong\n", "", ROOT)).toMatchObject({ ok: true, data: { state: "unhealthy" } });
  });

  it("redacts host paths, strips escapes, caps lines", () => {
    const raw = `${"problem at /home/op/secret/path \u001b[31mred\u001b[0m\n".repeat(80)}`;
    const result = parseHealth(1, raw, "", ROOT);
    expect(result.ok && result.data.problems.length).toBe(50);
    expect(JSON.stringify(result)).not.toContain("/home/op");
    expect(JSON.stringify(result)).not.toContain("[31m");
  });
});

describe("run status parsers", () => {
  it("parses the real lock-info format", () => {
    const lock = parseLockInfo(fixture("meute-root/state/lock-info"));
    expect(lock).toMatchObject({ ok: true, data: { state: "info", pid: 4242, slot: "daily", key: "sample/audit" } });
  });

  it("reports liveness for this process and a dead pid", () => {
    const alive = parseLockInfo(`pid=${process.pid} started=x slot=daily key=-`);
    expect(alive.ok && alive.data.state === "info" && alive.data.alive).toBe(true);
    const dead = parseLockInfo("pid=2147483646 started=x slot=daily key=-");
    expect(dead.ok && dead.data.state === "info" && dead.data.alive).toBe(false);
  });

  it.each(["", "garbage", "pid=abc started=x", "pid=-5", "pid=1.5e3", "pid=0", "pid=1", `pid=${"9".repeat(40)}`])(
    "never probes a hostile pid: %j", (raw) => {
      const lock = parseLockInfo(raw);
      if (lock.ok && lock.data.state === "info") expect(lock.data.alive).toBeNull();
    },
  );

  it("parses real log lines into whitelisted fields", () => {
    const lines = fixture("meute-root/state/log").split("\n").filter(Boolean);
    const entry = parseLogLine(lines[1] ?? "");
    expect(entry).toMatchObject({ time: "2026-11-24T03:17:01+00:00", fields: { status: "error", repo: "other", code: "failed", dur: "9s" } });
    expect(entry?.fields).not.toHaveProperty("image");
    expect(parseLogLine("")).toBeNull();
    expect(parseLogLine("\tstatus=ok")).toBeNull();
  });

  it("parses the plan queue and tolerates unknown fields; hides host paths", () => {
    const queue = parsePlanQueue(fixture("meute-root/state/plan-queue.json"));
    expect(queue).toMatchObject({ ok: true, data: { present: true, size: 2, names: ["sample/audit", "other/docs"] } });
    expect(JSON.stringify(queue)).not.toContain("/home/op");
    for (const raw of ["", "nope", "[]", '{"entries":5}', '{"entries":[1]}']) {
      expect(parsePlanQueue(raw)).toMatchObject({ ok: false, error: { code: "malformed" } });
    }
  });
});

describe("extractFindingExcerpt (mirrors lib/inbox.py finding_body)", () => {
  const report = fixture("meute-root/reports/sample/audit-2026-11-20.md");

  it("slices the n-th finding from its heading to the next", () => {
    const first = extractFindingExcerpt(report, 1);
    expect(first).toMatchObject({ ok: true, data: { severity: "HIGH", title: "SQL built by string concatenation" } });
    expect(first.ok && first.data.excerpt).toContain("src/db.py:42");
    expect(first.ok && first.data.excerpt).not.toContain("Unused import");
  });

  it("the last finding stops at the next top-level section", () => {
    const last = extractFindingExcerpt(report, 2);
    expect(last.ok && last.data.excerpt).toContain("Unused import");
    expect(last.ok && last.data.excerpt).not.toContain("Two findings");
  });

  it("keeps markup as inert text", () => {
    const first = extractFindingExcerpt(report, 1);
    expect(first.ok && first.data.excerpt).toContain("<script>alert(1)</script>");
  });

  it("rejects an out-of-range n", () => {
    for (const n of [0, 3, -1, 1.5, Number.NaN]) {
      expect(extractFindingExcerpt(report, n)).toMatchObject({ ok: false });
    }
  });

  it("handles CRLF, front matter and caps the excerpt", () => {
    const big = `---\r\nrepo: x\r\n---\r\n## Findings\r\n\r\n### [LOW] t\r\n${"y".repeat(50_000)}\r\n`;
    const result = extractFindingExcerpt(big, 1);
    expect(result.ok && result.data.truncated).toBe(true);
    expect(result.ok && result.data.excerpt.length).toBeLessThanOrEqual(16_001);
    expect(result.ok && result.data.excerpt).not.toContain("\r");
  });
});

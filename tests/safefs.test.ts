import { execFileSync } from "node:child_process";
import {
  appendFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_REPORT_BYTES, readLockInfo, readPlanQueue, readReportFile, tailLog,
} from "../server/safefs";

let dir: string;
let root: string;
let outside: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-fs-")));
  root = join(dir, "root");
  outside = join(dir, "outside");
  mkdirSync(join(root, "reports", "sample"), { recursive: true });
  mkdirSync(join(root, "state"));
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.md"), "TOP SECRET");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const code = (result: { ok: boolean; code?: string }) => (result.ok ? "ok" : result.code);

describe("reports", () => {
  it("reads a regular report", async () => {
    writeFileSync(join(root, "reports/sample/audit.md"), "hello");
    const result = await readReportFile(root, "sample", "audit");
    expect(result).toMatchObject({ ok: true, text: "hello" });
  });

  it("reports a missing report as not_found", async () => {
    expect(code(await readReportFile(root, "sample", "nope"))).toBe("not_found");
  });

  it.each([["..", "audit"], ["sample", ".."], ["sample/../..", "x"], ["", "x"], ["sample", ""], ["s\0", "x"],
    ["sample", "a/b"], ["-x", "a"], ["sample", "audit\n"], ["sample", "é"]])(
    "refuses identity %j / %j",
    async (repo, name) => {
      expect(code(await readReportFile(root, repo, name))).toBe("invalid_input");
    },
  );

  it("refuses a symlinked report that escapes the root", async () => {
    symlinkSync(join(outside, "secret.md"), join(root, "reports/sample/evil.md"));
    expect(code(await readReportFile(root, "sample", "evil"))).toBe("unsafe_path");
  });

  it("refuses a symlinked report that stays inside the root", async () => {
    writeFileSync(join(root, "state/real"), "x");
    symlinkSync(join(root, "state/real"), join(root, "reports/sample/inside.md"));
    expect(code(await readReportFile(root, "sample", "inside"))).toBe("unsafe_path");
  });

  it("refuses a symlinked repo directory", async () => {
    symlinkSync(outside, join(root, "reports/linked"));
    writeFileSync(join(outside, "audit.md"), "leak");
    expect(code(await readReportFile(root, "linked", "audit"))).toBe("unsafe_path");
  });

  it("refuses a symlinked reports directory", async () => {
    rmSync(join(root, "reports"), { recursive: true });
    symlinkSync(outside, join(root, "reports"));
    mkdirSync(join(outside, "sample"));
    writeFileSync(join(outside, "sample/x.md"), "leak");
    expect(code(await readReportFile(root, "sample", "x"))).toBe("unsafe_path");
  });

  it("refuses a FIFO without blocking", async () => {
    execFileSync("mkfifo", [join(root, "reports/sample/pipe.md")]);
    const result = await Promise.race([
      readReportFile(root, "sample", "pipe"),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 3000)),
    ]);
    expect(result).not.toBe("hung");
    expect(code(result as { ok: boolean; code?: string })).toBe("unsafe_path");
  });

  it("refuses a directory named like a report", async () => {
    mkdirSync(join(root, "reports/sample/dir.md"));
    expect(code(await readReportFile(root, "sample", "dir"))).toBe("unsafe_path");
  });

  it("refuses a hard-linked report (nlink != 1)", async () => {
    writeFileSync(join(outside, "target"), "x");
    linkSync(join(outside, "target"), join(root, "reports/sample/hard.md"));
    expect(code(await readReportFile(root, "sample", "hard"))).toBe("unsafe_path");
  });

  it("refuses a report over the size cap", async () => {
    writeFileSync(join(root, "reports/sample/huge.md"), Buffer.alloc(MAX_REPORT_BYTES + 1, 97));
    expect(code(await readReportFile(root, "sample", "huge"))).toBe("too_large");
  });

  it("accepts a report exactly at the cap", async () => {
    writeFileSync(join(root, "reports/sample/edge.md"), Buffer.alloc(MAX_REPORT_BYTES, 97));
    expect(code(await readReportFile(root, "sample", "edge"))).toBe("ok");
  });

  it("does not mention host paths in errors", async () => {
    symlinkSync(join(outside, "secret.md"), join(root, "reports/sample/evil.md"));
    const result = await readReportFile(root, "sample", "evil");
    expect(JSON.stringify(result)).not.toContain(dir);
  });

  it("refuses a root that is not an absolute directory", async () => {
    expect(code(await readReportFile("relative", "sample", "x"))).toBe("invalid_config");
    expect(code(await readReportFile(join(dir, "missing"), "sample", "x"))).toBe("unavailable");
  });
});

describe("state files", () => {
  it("returns absent lock-info as not_found", async () => {
    expect(code(await readLockInfo(root))).toBe("not_found");
  });

  it("reads lock-info", async () => {
    writeFileSync(join(root, "state/lock-info"), "pid=1 started=x slot=daily key=-\n");
    expect(await readLockInfo(root)).toMatchObject({ ok: true });
  });

  it("refuses a symlinked lock-info, a FIFO and an oversize one", async () => {
    symlinkSync(join(outside, "secret.md"), join(root, "state/lock-info"));
    expect(code(await readLockInfo(root))).toBe("unsafe_path");
    rmSync(join(root, "state/lock-info"));
    execFileSync("mkfifo", [join(root, "state/lock-info")]);
    expect(code(await readLockInfo(root))).toBe("unsafe_path");
    rmSync(join(root, "state/lock-info"));
    writeFileSync(join(root, "state/lock-info"), "x".repeat(10_000));
    expect(code(await readLockInfo(root))).toBe("too_large");
  });

  it("refuses an oversize or symlinked plan queue", async () => {
    writeFileSync(join(root, "state/plan-queue.json"), "x".repeat(2 * 1024 * 1024));
    expect(code(await readPlanQueue(root))).toBe("too_large");
    rmSync(join(root, "state/plan-queue.json"));
    symlinkSync(join(outside, "secret.md"), join(root, "state/plan-queue.json"));
    expect(code(await readPlanQueue(root))).toBe("unsafe_path");
  });

  it("refuses a symlinked state directory", async () => {
    rmSync(join(root, "state"), { recursive: true });
    symlinkSync(outside, join(root, "state"));
    writeFileSync(join(outside, "lock-info"), "pid=1");
    expect(code(await readLockInfo(root))).toBe("unsafe_path");
  });
});

describe("log tail", () => {
  it("returns the last lines of a small log", async () => {
    writeFileSync(join(root, "state/log"), "a\nb\nc\n");
    expect(await tailLog(root, { lines: 2 })).toMatchObject({ ok: true, lines: ["b", "c"], partial: false });
  });

  it("reads only the tail of a huge log and drops the cut-off first line", async () => {
    const line = `${"x".repeat(99)}\n`;
    writeFileSync(join(root, "state/log"), line.repeat(10_000)); // ~1 MB
    appendFileSync(join(root, "state/log"), "last\n");
    const result = await tailLog(root, { lines: 3, tailBytes: 4096 });
    expect(result).toMatchObject({ ok: true, partial: true });
    if (result.ok) {
      expect(result.lines.at(-1)).toBe("last");
      expect(result.lines).toHaveLength(3);
      expect(result.size).toBeGreaterThan(1_000_000);
    }
  });

  it("asks for more lines than the window holds: every returned line is whole, none is the cut one", async () => {
    // 1000 numbered lines of 20 bytes; a 1010-byte window holds 50 whole lines plus half of one.
    const lines = Array.from({ length: 1000 }, (_, i) => `entry-${String(i).padStart(4, "0")}-padpadpa`);
    writeFileSync(join(root, "state/log"), `${lines.join("\n")}\n`);
    const result = await tailLog(root, { lines: 100, tailBytes: 1010 });
    expect(result).toMatchObject({ ok: true, partial: true });
    if (!result.ok) return;
    expect(result.lines).toEqual(lines.slice(-50)); // exactly the whole lines in the window
    for (const line of result.lines) expect(line).toMatch(/^entry-\d{4}-padpadpa$/);
  });

  it("keeps the first line when the window starts exactly on a line boundary", async () => {
    writeFileSync(join(root, "state/log"), "l1\nl2\n");
    expect(await tailLog(root, { lines: 10, tailBytes: 3 })).toMatchObject({ ok: true, lines: ["l2"], partial: true });
    expect(await tailLog(root, { lines: 10, tailBytes: 4 })).toMatchObject({ ok: true, lines: ["l2"], partial: true });
  });

  it("never returns more lines than requested", async () => {
    writeFileSync(join(root, "state/log"), "x\n".repeat(1000));
    const result = await tailLog(root, { lines: 5 });
    expect(result.ok && result.lines.length).toBe(5);
  });

  it("handles an empty log and a missing log", async () => {
    writeFileSync(join(root, "state/log"), "");
    expect(await tailLog(root, { lines: 5 })).toMatchObject({ ok: true, lines: [] });
    rmSync(join(root, "state/log"));
    expect(code(await tailLog(root, { lines: 5 }))).toBe("not_found");
  });

  it("refuses symlink, FIFO and bounds the requested tail", async () => {
    symlinkSync(join(outside, "secret.md"), join(root, "state/log"));
    expect(code(await tailLog(root, { lines: 5 }))).toBe("unsafe_path");
    rmSync(join(root, "state/log"));
    execFileSync("mkfifo", [join(root, "state/log")]);
    expect(code(await tailLog(root, { lines: 5 }))).toBe("unsafe_path");
    rmSync(join(root, "state/log"));
    writeFileSync(join(root, "state/log"), "x\n");
    expect(code(await tailLog(root, { lines: 5, tailBytes: 1e12 }))).toBe("ok");
  });
});

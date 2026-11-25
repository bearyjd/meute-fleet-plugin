// Every documented cap, pinned with LITERAL numbers (review 06 tests CAPS). This file imports
// functions only, never the constants, so a changed constant fails here.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { INITIAL_POLL, reducePoll } from "../client/viewmodel";
import { parseFindings, parseReadiness } from "../server/parsers";
import { runAllowlisted } from "../server/runner";
import { readReportFile, tailLog } from "../server/safefs";
import { makeSandbox, type Sandbox } from "./helpers";

let box: Sandbox | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
});

describe("documented caps", () => {
  it("meute output: 2 MB (2,097,152 bytes) per stream by default, then truncated", async () => {
    box = makeSandbox("yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const result = await runAllowlisted(box.config, "findings_list");
    expect(result).toMatchObject({ ok: false, code: "truncated" });
    expect(!result.ok && (result.stdout ?? "").length).toBe(2_097_152);
  });

  it("reports: 4 MiB (4,194,304 bytes) is read, one byte more is too_large", async () => {
    box = makeSandbox("true");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(box.root, "reports/r"));
    writeFileSync(join(box.root, "reports/r/fits.md"), Buffer.alloc(4_194_304, 0x61));
    writeFileSync(join(box.root, "reports/r/over.md"), Buffer.alloc(4_194_305, 0x61));
    expect(await readReportFile(box.root, "r", "fits")).toMatchObject({ ok: true, size: 4_194_304 });
    expect(await readReportFile(box.root, "r", "over")).toMatchObject({ ok: false, code: "too_large" });
  });

  it("log tail: at most 256 KiB (262,144 bytes) whatever is requested", async () => {
    box = makeSandbox("true");
    // "a\n" + one line that fills the 256 KiB window exactly + "\nlast\n": the window holds the long
    // line whole (the byte before it is "\n") but not "a".
    const long = "x".repeat(262_144 - 6);
    writeFileSync(join(box.root, "state/log"), `a\n${long}\nlast\n`);
    const result = await tailLog(box.root, { lines: 100, tailBytes: 1e12 });
    expect(result).toMatchObject({ ok: true, partial: true, lines: [long, "last"] });
  });

  it("log tail: at most 100 lines", async () => {
    box = makeSandbox("true");
    writeFileSync(join(box.root, "state/log"), "x\n".repeat(1000));
    const result = await tailLog(box.root, { lines: 10_000 });
    expect(result.ok && result.lines.length).toBe(100);
  });

  it("stale data is dropped 5 minutes (300,000 ms) after the last good answer", () => {
    const good = reducePoll(INITIAL_POLL, { ok: true, data: "d", observedAt: "t" }, 0);
    const error = { ok: false as const, error: { code: "timeout" as const, message: "m" } };
    expect(reducePoll(good, error, 300_000).data).toBe("d");
    expect(reducePoll(good, error, 300_001).data).toBeUndefined();
  });

  it("findings: 5000 are accepted, 5001 is malformed", () => {
    const finding = (n: number) => ({ id: `r/a#${n}`, report: "r/a", n, repo: "r", severity: "LOW", title: "t", state: "new" });
    const list = (count: number) => JSON.stringify(Array.from({ length: count }, (_, i) => finding(i + 1)));
    expect(parseFindings(list(5000), "")).toMatchObject({ ok: true });
    expect(parseFindings(list(5001), "")).toMatchObject({ ok: false, error: { code: "malformed" } });
  });

  it("readiness: 200 checks are accepted, 201 is malformed", () => {
    const body = (count: number) => JSON.stringify({
      version: 1, status: "pending", checks: Array.from({ length: count }, (_, i) => ({ check: `c${i}`, status: "pending", reason: "r" })),
    });
    expect(parseReadiness(1, body(200), "/r")).toMatchObject({ ok: true });
    expect(parseReadiness(1, body(201), "/r")).toMatchObject({ ok: false, error: { code: "malformed" } });
  });
});

// Parent-directory symlink swap (review 06 files F2): the reviewer's rename loop leaked 2177 of
// 40681 reads from outside the root. Time-boxed regression; the swapper is killed in finally.
import { spawn } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLockInfo, readReportFile, tailLog } from "../server/safefs";
import { makeSandbox } from "./helpers";

const SWAPPER = `
import os, sys, time
root, outside = sys.argv[1], sys.argv[2]
d = os.path.join(root, "reports", "r"); real = d + ".real"; ln = d + ".ln"
os.symlink(outside, ln)
end = time.time() + 20
while time.time() < end:
    os.rename(d, real); os.rename(ln, d)
    os.rename(d, ln); os.rename(real, d)
`;

describe("safefs under a racing parent-directory swap", () => {
  it("never returns a file from outside the root", async () => {
    const box = makeSandbox("true");
    mkdirSync(join(box.root, "reports/r"));
    mkdirSync(join(box.dir, "outside"));
    writeFileSync(join(box.root, "reports/r/x.md"), "### [HIGH] benign\n");
    writeFileSync(join(box.dir, "outside/x.md"), "### [HIGH] SECRET\n");
    const swapper = spawn("python3", ["-I", "-c", SWAPPER, box.root, join(box.dir, "outside")], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      let leaks = 0;
      let reads = 0;
      let benign = 0;
      // Count-bounded (with a time cap), so a loaded host still gets enough swaps in.
      const end = Date.now() + 15_000;
      while ((reads < 2000 || benign === 0) && Date.now() < end) {
        const result = await readReportFile(box.root, "r", "x");
        reads += 1;
        if (result.ok && result.text.includes("SECRET")) leaks += 1;
        else if (result.ok) benign += 1;
      }
      const counts = JSON.stringify({ reads, benign, leaks });
      expect(reads, counts).toBeGreaterThan(100);
      expect(benign, counts).toBeGreaterThan(0); // the swap really alternated
      expect(leaks, counts).toBe(0);
    } finally {
      swapper.kill("SIGKILL");
      box.cleanup();
    }
  });
});

describe("dangling links are refused, not read as missing (review 06 files F7)", () => {
  it("a dangling state/lock-info or state/log symlink is unsafe_path", async () => {
    const box = makeSandbox("true");
    try {
      symlinkSync(join(box.dir, "nowhere"), join(box.root, "state/lock-info"));
      symlinkSync(join(box.dir, "nowhere"), join(box.root, "state/log"));
      expect(await readLockInfo(box.root)).toMatchObject({ ok: false, code: "unsafe_path" });
      expect(await tailLog(box.root, { lines: 5 })).toMatchObject({ ok: false, code: "unsafe_path" });
    } finally {
      box.cleanup();
    }
  });
});

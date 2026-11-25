// Hard-timeout, in-flight, pid-reuse and concurrency guarantees of the runner
// (review 06: runner F2/F4/F6/F7, paseo F1). Each stub that escapes the process group writes its
// pid beside the root, and afterEach kills it, so nothing leaks into later runs.
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runAllowlisted, type RunOutcome } from "../server/runner";
import { makeSandbox, type Sandbox } from "./helpers";

let box: Sandbox | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (box) {
    for (const name of ["gc.pid", "gc2.pid"]) {
      const file = join(box.dir, name);
      if (!existsSync(file)) continue;
      for (const pid of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    box.cleanup();
  }
  box = undefined;
});

const ESCAPE = 'printf "%s\\n" "$$" >> "$(dirname "$MEUTE_ROOT")/runs"; setsid sleep 30 & echo $! >> "$(dirname "$MEUTE_ROOT")/gc.pid"; exit 0';
const race = (promise: Promise<RunOutcome>, ms: number) =>
  Promise.race([promise, new Promise<"PENDING">((resolve) => setTimeout(() => resolve("PENDING"), ms))]);
const runs = (dir: string) => (existsSync(join(dir, "runs")) ? readFileSync(join(dir, "runs"), "utf8").split("\n").filter(Boolean).length : 0);

describe("the runner settles no matter what the child's descendants do", () => {
  it("settles at the deadline when a setsid descendant holds stdout open", async () => {
    // The leader stays alive until the group kill, so only the hard settle timer can end it in time.
    box = makeSandbox(ESCAPE.replace("; exit 0", "; sleep 30"));
    const started = Date.now();
    const result = await race(runAllowlisted({ ...box.config, timeoutMs: 300, graceMs: 200 }, "health"), 6000);
    expect(result).not.toBe("PENDING");
    // timeout + grace + 0.5 s margin = 1 s; the 2 s exit drain alone would take 2.5 s.
    expect(Date.now() - started).toBeLessThan(2200);
    expect(result).toMatchObject({ ok: false });
  });

  it("an exit 0 whose descendant keeps the output open is never a clean answer", async () => {
    box = makeSandbox(ESCAPE);
    const result = await race(runAllowlisted({ ...box.config, timeoutMs: 15_000 }, "health"), 6000);
    expect(result).not.toBe("PENDING");
    expect(result).toMatchObject({ ok: false });
  });

  it("clears the in-flight entry on settle, so a later identical call runs fresh", async () => {
    box = makeSandbox(ESCAPE);
    // A generous timeout, so a loaded host has started both stubs before any deadline.
    const config = { ...box.config, timeoutMs: 1500, graceMs: 200 };
    const first = runAllowlisted(config, "health");
    const shared = runAllowlisted(config, "health");
    expect(shared).toBe(first);
    expect(await race(first, 6000)).not.toBe("PENDING");
    const second = await race(runAllowlisted(config, "health"), 6000);
    expect(second).not.toBe("PENDING");
    expect(runs(box.dir)).toBe(2);
  });

  it("sends SIGTERM at the deadline before any SIGKILL (graceful stop)", async () => {
    box = makeSandbox('trap \'echo term >> "$(dirname "$MEUTE_ROOT")/got-term"; exit 0\' TERM; sleep 60 & echo $! >> "$(dirname "$MEUTE_ROOT")/gc.pid"; wait');
    const result = await runAllowlisted({ ...box.config, timeoutMs: 500, graceMs: 1500 }, "health");
    expect(result).toMatchObject({ ok: false, code: "timeout" });
    expect(existsSync(join(box.dir, "got-term"))).toBe(true);
  });

  it("never signals a bare pid after the child has exited (pid reuse)", async () => {
    box = makeSandbox("exit 0");
    const real = process.kill.bind(process);
    const calls: Array<[number, unknown]> = [];
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      calls.push([pid, signal]);
      return real(pid, signal);
    }) as typeof process.kill);
    const result = await runAllowlisted(box.config, "health");
    expect(result.ok).toBe(true);
    expect(calls.filter(([pid]) => pid > 0)).toEqual([]);
  });

  it("does not share a child between calls with different environments", async () => {
    box = makeSandbox('sleep 0.3; echo "$PATH"');
    const tools = join(box.dir, "tools");
    mkdirSync(tools);
    chmodSync(tools, 0o755);
    const [a, b] = await Promise.all([
      runAllowlisted({ ...box.config, runnerPath: "/usr/bin" }, "health"),
      runAllowlisted({ ...box.config, runnerPath: `${tools}:/usr/bin` }, "health"),
    ]);
    expect(a.ok && a.stdout.trim()).toBe("/usr/bin");
    expect(b.ok && b.stdout.trim()).toBe(`${tools}:/usr/bin`);
  });

  it("bounds concurrent children: beyond 4, calls are refused instead of spawning", async () => {
    box = makeSandbox('printf "x\\n" >> "$(dirname "$MEUTE_ROOT")/runs"; sleep 1');
    const results = await Promise.all(
      Array.from({ length: 7 }, (_, i) =>
        runAllowlisted(box!.config, "readiness_validate", { record: `/r/${i}.json`, policy: "/p.json" })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    const refused = results.filter((r) => !r.ok);
    expect(refused).toHaveLength(3);
    for (const r of refused) expect(r).toMatchObject({ ok: false, code: "unavailable" });
    expect(runs(box.dir)).toBe(4);
  });
});

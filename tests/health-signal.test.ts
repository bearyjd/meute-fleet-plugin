// Health may be "healthy" only with a positive signal that systemd was visible (review 06 runner F1):
// meute prints nothing when `systemctl --user` cannot reach the user bus, which looks identical
// to a healthy fleet.
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { health } from "../server/fleet";
import { parseHealth } from "../server/parsers";
import { copyRealMeute, makeFixtureRoot, makeSandbox, realMeuteSource, type FixtureRoot } from "./helpers";

let box: FixtureRoot | undefined;
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  box?.cleanup();
  box = undefined;
});

/** A runtime dir (0700) holding a listening `bus` socket. */
async function fakeSession(dir: string): Promise<{ xdgRuntimeDir: string }> {
  const xdgRuntimeDir = join(dir, "run");
  mkdirSync(xdgRuntimeDir, { mode: 0o700 });
  const listening = createServer();
  server = listening;
  await new Promise<void>((resolve) => listening.listen(join(xdgRuntimeDir, "bus"), resolve));
  return { xdgRuntimeDir };
}

describe("M3: health trusts only what the runner passed to the child", () => {
  /** A 0700 runtime dir whose bus accepts `accepts` connections, then stops listening. Counts connections. */
  async function countingBus(dir: string, accepts: number) {
    const xdgRuntimeDir = join(dir, "run");
    mkdirSync(xdgRuntimeDir, { mode: 0o700 });
    const state = { connections: 0 };
    const listening = createServer((socket) => {
      state.connections += 1;
      socket.destroy();
      if (state.connections >= accepts) listening.close();
    });
    server = listening;
    await new Promise<void>((resolve) => listening.listen(join(xdgRuntimeDir, "bus"), resolve));
    return { xdgRuntimeDir, state };
  }
  // A stub that prints nothing (meute's reading of a healthy fleet) and records its environment.
  const recordingStub = 'env > "$(dirname "$MEUTE_ROOT")/env.out"';
  const childHadRuntimeDir = (dir: string) => /^XDG_RUNTIME_DIR=/m.test(readFileSync(join(dir, "env.out"), "utf8"));

  it("a bus that accepts once, then closes: healthy only if the child really got XDG_RUNTIME_DIR", async () => {
    const sandbox = makeSandbox(recordingStub);
    try {
      const bus = await countingBus(sandbox.dir, 1);
      const result = await health({ ...sandbox.config, xdgRuntimeDir: bus.xdgRuntimeDir });
      expect(result.ok).toBe(true);
      const state = result.ok ? result.data.state : "";
      expect(state === "healthy").toBe(childHadRuntimeDir(sandbox.dir));
      expect(state).toBe("healthy"); // the one probe (the runner's, right before the spawn) got the accept
    } finally {
      sandbox.cleanup();
    }
  });

  it("a bus that is gone before the spawn: unknown, and the child got no XDG_RUNTIME_DIR", async () => {
    const sandbox = makeSandbox(recordingStub);
    try {
      const bus = await countingBus(sandbox.dir, 1);
      await new Promise<void>((resolve, reject) => {
        const probe = connect(join(bus.xdgRuntimeDir, "bus"), () => resolve());
        probe.on("error", reject);
      }); // something else used the bus's last accept
      await new Promise((resolve) => setTimeout(resolve, 50));
      const result = await health({ ...sandbox.config, xdgRuntimeDir: bus.xdgRuntimeDir });
      expect(result).toMatchObject({ ok: true, data: { state: "unknown" } });
      expect(childHadRuntimeDir(sandbox.dir)).toBe(false);
    } finally {
      sandbox.cleanup();
    }
  });

  it("a live bus behind a path the child may not get (`/./`) is unknown: the report is what was passed", async () => {
    const sandbox = makeSandbox(recordingStub);
    try {
      const bus = await countingBus(sandbox.dir, 1_000);
      const dotted = bus.xdgRuntimeDir.replace(/\/run$/, "/./run");
      expect(await health({ ...sandbox.config, xdgRuntimeDir: dotted })).toMatchObject({ ok: true, data: { state: "unknown" } });
      expect(childHadRuntimeDir(sandbox.dir)).toBe(false);
    } finally {
      sandbox.cleanup();
    }
  });

  it("health makes no probe of its own: one bus connection per call", async () => {
    const sandbox = makeSandbox(recordingStub);
    try {
      const bus = await countingBus(sandbox.dir, 1_000);
      for (let call = 1; call <= 3; call++) {
        expect(await health({ ...sandbox.config, xdgRuntimeDir: bus.xdgRuntimeDir })).toMatchObject({ ok: true, data: { state: "healthy" } });
        expect(bus.state.connections).toBe(call);
      }
    } finally {
      sandbox.cleanup();
    }
  });
});

describe("health needs a visible user bus before it can be healthy", () => {
  it("default config (no XDG_RUNTIME_DIR) is unknown with a clear message, never healthy", async () => {
    box = makeFixtureRoot();
    const result = await health(box.config);
    expect(result).toMatchObject({ ok: true, data: { state: "unknown" } });
    expect(result.ok && result.data.problems.join(" ")).toMatch(/set XDG_RUNTIME_DIR/);
  });

  it("a configured runtime dir without a bus socket is unknown", async () => {
    box = makeFixtureRoot();
    const runtime = join(box.dir, "run");
    mkdirSync(runtime, { mode: 0o700 });
    const result = await health({ ...box.config, xdgRuntimeDir: runtime });
    expect(result).toMatchObject({ ok: true, data: { state: "unknown" } });
  });

  it("a bus socket in a runtime dir others can enter is unknown", async () => {
    box = makeFixtureRoot();
    const session = await fakeSession(box.dir);
    chmodSync(session.xdgRuntimeDir, 0o755);
    expect(await health({ ...box.config, ...session })).toMatchObject({ ok: true, data: { state: "unknown" } });
  });

  it("a regular file named bus is unknown", async () => {
    box = makeFixtureRoot();
    const runtime = join(box.dir, "run");
    mkdirSync(runtime, { mode: 0o700 });
    writeFileSync(join(runtime, "bus"), "");
    expect(await health({ ...box.config, xdgRuntimeDir: runtime }))
      .toMatchObject({ ok: true, data: { state: "unknown" } });
  });

  it("is healthy with a live bus and empty output", async () => {
    box = makeFixtureRoot();
    const session = await fakeSession(box.dir);
    expect(await health({ ...box.config, ...session })).toMatchObject({ ok: true, data: { state: "healthy", problems: [] } });
  });

  it("N3: a leftover bus socket with no listener (dead user manager) is unknown, not healthy", async () => {
    box = makeFixtureRoot();
    const runtime = join(box.dir, "run");
    mkdirSync(runtime, { mode: 0o700 });
    execFileSync("python3", ["-I", "-c", "import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])", join(runtime, "bus")]);
    const result = await health({ ...box.config, xdgRuntimeDir: runtime });
    expect(result).toMatchObject({ ok: true, data: { state: "unknown" } });
    expect(result.ok && result.data.problems.join(" ")).toMatch(/no user bus is listening/);
  });

  it("problem lines stay unhealthy without a bus (only healthy is downgraded)", async () => {
    box = makeFixtureRoot();
    box.setMode("unhealthy");
    expect(await health(box.config)).toMatchObject({ ok: true, data: { state: "unhealthy" } });
  });
});

describe("healthy needs raw-empty stdout and stderr (review 06 runner F5)", () => {
  it.each([
    ["   \n\t\n", ""], ["\u001b[0m\n", ""], ["", "  \n"], ["\n", ""],
  ])("exit 0 with stdout %j stderr %j is not healthy", (stdout, stderr) => {
    expect(parseHealth(0, stdout, stderr, "/r")).toMatchObject({ ok: true, data: { state: "unknown" } });
  });
  it("exit 0 with nothing at all is healthy (before the bus check)", () => {
    expect(parseHealth(0, "", "", "/r")).toMatchObject({ ok: true, data: { state: "healthy" } });
  });
});

const real = realMeuteSource();
describe.skipIf("skip" in real)(`real meute health without systemd ${"skip" in real ? `[SKIPPED: ${real.skip}]` : ""}`, () => {
  const setup = (systemctl: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-health-")));
    const stubs = join(dir, "stubs");
    mkdirSync(stubs, { mode: 0o755 });
    chmodSync(stubs, 0o755);
    writeFileSync(join(stubs, "systemctl"), `#!/bin/sh\n${systemctl}\n`, { mode: 0o755 });
    const config = copyRealMeute((real as { source: string }).source, join(dir, "root"));
    return { dir, config: { ...config, runnerPath: `${stubs}:/usr/bin` } };
  };

  it("systemctl exits 1 (no bus): unknown, not healthy", async () => {
    const { dir, config } = setup("exit 1");
    try {
      const result = await health({ ...config, timeoutMs: 20_000 });
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && result.data.state).not.toBe("healthy");
      expect(result.ok && result.data.state).toBe("unknown");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("systemctl reports the timers not-found: unhealthy with 'not armed' lines", async () => {
    const { dir, config } = setup("echo LoadState=not-found");
    try {
      const result = await health({ ...config, timeoutMs: 20_000 });
      expect(result).toMatchObject({ ok: true, data: { state: "unhealthy" } });
      expect(result.ok && result.data.problems.join("\n")).toMatch(/not armed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

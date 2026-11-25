// The child's HOME and XDG dirs are not attacker-reachable (re-review 07: runner N4, tests B2).
// meute runs python3 without -I, so a writable HOME means user site-packages (.pth) run as the
// daemon user. The child always gets a plugin-owned, empty, 0700 HOME; XDG_RUNTIME_DIR is passed
// only while it is a private dir of the daemon user with a live bus socket (checked every call).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../server/config";
import { runAllowlisted, type RunnerConfig } from "../server/runner";
import { assertPrivateTestHome, makeSandbox, type Sandbox } from "./helpers";

let box: Sandbox | undefined;
let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  box?.cleanup();
  box = undefined;
});

const uid = process.getuid?.() ?? 0;
const envOf = (stdout: string) =>
  new Map(stdout.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

async function childEnv(config: RunnerConfig): Promise<Map<string, string>> {
  const result = await runAllowlisted(config, "health");
  expect(result.ok).toBe(true);
  const env = envOf(result.ok ? result.stdout : "");
  // Tests below change the child's HOME: never let that be a real directory (a mutant that passes
  // the daemon's HOME through once made this test chmod the developer's home).
  if (env.has("HOME")) assertPrivateTestHome(env.get("HOME"));
  return env;
}

/** A 0777 directory with a user-site .pth that writes a marker when any python3 starts. */
function hostileHome(dir: string, marker: string): string {
  const home = join(dir, "evil-home");
  const version = execFileSync("python3", ["-I", "-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"], { encoding: "utf8" }).trim();
  const site = join(home, ".local", "lib", `python${version}`, "site-packages");
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, "zz.pth"), `import os; open(${JSON.stringify(marker)}, "w").close()\n`);
  writeFileSync(join(home, ".gitconfig"), "[core]\n\tfsmonitor = touch-marker\n");
  chmodSync(home, 0o777);
  return home;
}

describe("the child gets a private, empty HOME", () => {
  it("a 0777 HOME with a hostile .pth is never used: the marker is not created", async () => {
    box = makeSandbox('python3 -c "print(1)"; echo "HOME=$HOME"');
    const marker = join(box.dir, "pwned");
    const evil = hostileHome(box.dir, marker);
    // Sanity: this python really would run the .pth from that HOME.
    execFileSync("python3", ["-c", "pass"], { env: { PATH: "/usr/bin:/bin", HOME: evil } });
    expect(existsSync(marker)).toBe(true);
    execFileSync("rm", [marker]);
    const savedHome = process.env["HOME"];
    process.env["HOME"] = evil; // the daemon's own HOME is not inherited either
    try {
      const settings = { meutePath: box.config.meutePath, meuteRoot: box.config.meuteRoot, readinessRecordPath: "", readinessPolicyPath: "", runnerPath: "", xdgRuntimeDir: "", homeDir: evil };
      const config = await resolveConfig(settings as never);
      expect(config.ok).toBe(true);
      const result = await runAllowlisted({ ...(config.ok ? config.data : box.config), homeDir: evil } as RunnerConfig, "findings_list");
      expect(result.ok).toBe(true);
      expect(result.ok && result.stdout).not.toContain(evil);
    } finally {
      process.env["HOME"] = savedHome;
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("sets HOME, XDG_{CONFIG,DATA,CACHE}_HOME inside it, and the python/git isolation variables", async () => {
    box = makeSandbox("env");
    const env = await childEnv(box.config);
    const home = env.get("HOME") ?? "";
    expect(home.startsWith(join(tmpdir(), "meute-fleet-home-"))).toBe(true);
    const info = lstatSync(home);
    expect(info.isDirectory() && info.uid === uid && (info.mode & 0o777) === 0o700).toBe(true);
    expect(readdirSync(home)).toEqual([]);
    expect(env.get("XDG_CONFIG_HOME")).toBe(join(home, ".config"));
    expect(env.get("XDG_DATA_HOME")).toBe(join(home, ".local", "share"));
    expect(env.get("XDG_CACHE_HOME")).toBe(join(home, ".cache"));
    expect(env.get("PYTHONNOUSERSITE")).toBe("1");
    expect(env.get("PYTHONDONTWRITEBYTECODE")).toBe("1");
    expect(env.get("GIT_CONFIG_GLOBAL")).toBe("/dev/null");
    expect(env.get("GIT_CONFIG_NOSYSTEM")).toBe("1");
    expect(env.has("XDG_RUNTIME_DIR")).toBe(false);
  });

  it("re-verifies the HOME on every call: one made writable or non-empty is replaced", async () => {
    box = makeSandbox('echo "HOME=$HOME"');
    const first = (await childEnv(box.config)).get("HOME") ?? "";
    expect((await childEnv(box.config)).get("HOME")).toBe(first); // reused while intact
    chmodSync(first, 0o777);
    const second = (await childEnv(box.config)).get("HOME") ?? "";
    expect(second).not.toBe(first);
    writeFileSync(join(second, ".gitconfig"), "");
    const third = (await childEnv(box.config)).get("HOME") ?? "";
    expect(third).not.toBe(second);
    expect(readdirSync(third)).toEqual([]);
  });
});

/** A 0700 runtime dir holding a `bus` socket: live (listening) or dead (bound, never listening). */
async function runtimeDir(dir: string, live: boolean): Promise<string> {
  const runtime = join(dir, "run");
  mkdirSync(runtime, { mode: 0o700 });
  const bus = join(runtime, "bus");
  if (live) {
    const listening = createServer();
    server = listening;
    await new Promise<void>((resolve) => listening.listen(bus, resolve));
  } else {
    execFileSync("python3", ["-I", "-c", "import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])", bus]);
  }
  return runtime;
}

describe("XDG_RUNTIME_DIR reaches the child only while it is the daemon user's live session", () => {
  it("passes a private runtime dir with a live bus", async () => {
    box = makeSandbox("env");
    const runtime = await runtimeDir(box.dir, true);
    expect((await childEnv({ ...box.config, xdgRuntimeDir: runtime })).get("XDG_RUNTIME_DIR")).toBe(runtime);
  });

  it("drops it when the runtime dir is open to others (checked on each call, not at save time)", async () => {
    box = makeSandbox("env");
    const runtime = await runtimeDir(box.dir, true);
    expect((await childEnv({ ...box.config, xdgRuntimeDir: runtime })).has("XDG_RUNTIME_DIR")).toBe(true);
    chmodSync(runtime, 0o777);
    expect((await childEnv({ ...box.config, xdgRuntimeDir: runtime })).has("XDG_RUNTIME_DIR")).toBe(false);
  });

  it("drops it when the bus socket has no listener (N3: a dead user manager)", async () => {
    box = makeSandbox("env");
    const runtime = await runtimeDir(box.dir, false);
    expect(lstatSync(join(runtime, "bus")).isSocket()).toBe(true);
    expect((await childEnv({ ...box.config, xdgRuntimeDir: runtime })).has("XDG_RUNTIME_DIR")).toBe(false);
  });
});

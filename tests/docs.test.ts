// The docs state exactly what is enforced (re-review 07 tests D1-D3, "keyword-only docs tests").
// Each security claim is one test: the README sentence AND a probe of the guard behind it, so
// removing the guard (or the sentence) fails here. Deployment prerequisites are checked as text.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Another uid without privileges: a path whose last component is "foreign-owner" reports a
// foreign uid (as in ownership.test.ts). Every other path sees the real lstat.
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const lstat = (async (path: string, options?: { bigint?: boolean }) => {
    const info = await real.lstat(path, options as never);
    if (String(path).includes("/root-owned-install/") && String(path).endsWith("/bin/meute")) {
      return new Proxy(info, { get: (target, key) => (key !== "uid" ? (Reflect.get(target, key) as unknown) : typeof target.uid === "bigint" ? 0n : 0) });
    }
    if (String(path).split("/").pop() !== "foreign-owner") return info;
    return new Proxy(info, {
      get: (target, key) => (key !== "uid" ? (Reflect.get(target, key) as unknown)
        : typeof target.uid === "bigint" ? target.uid + 4242n : Number(target.uid) + 4242),
    });
  }) as typeof real.lstat;
  return { ...real, lstat, default: { ...real, lstat } };
});

const { checkExecutable } = await import("../server/config");
const { health } = await import("../server/fleet");
const { runAllowlisted } = await import("../server/runner");
const { checkCodeTree, MAX_TREE_ENTRIES } = await import("../server/tree");
const { fleetSettings } = await import("../shared/settings");
const { assertPrivateTestHome, assertTestHome, makeFixtureRoot, makeSandbox, realMeuteSource, testRoot } = await import("./helpers");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name: string) => readFileSync(join(ROOT, name), "utf8");
const README = read("README.md");
const OVERVIEW = read("OVERVIEW.md");
const flat = (text: string) => text.replace(/\s+/g, " ");
const head = (text: string, lines: number) => flat(text.split("\n").slice(0, lines).join("\n"));

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const done of cleanup) done();
  cleanup = [];
});
const sandbox = (body = "true") => {
  const box = makeSandbox(body);
  cleanup.push(box.cleanup);
  return box;
};
const refused = async (config: Parameters<typeof checkExecutable>[0]) => (await checkExecutable(config)).ok === false;
const envOf = async (config: Parameters<typeof runAllowlisted>[0]) => {
  const run = await runAllowlisted(config, "health");
  expect(run.ok).toBe(true);
  const home = /^HOME=(.*)$/m.exec(run.ok ? run.stdout : "")?.[1];
  if (home !== undefined) assertPrivateTestHome(home);
  return new Map((run.ok ? run.stdout : "").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
};
const deadBus = (dir: string) => {
  const runtime = join(dir, "run");
  mkdirSync(runtime, { mode: 0o700 });
  execFileSync("python3", ["-I", "-c", "import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])", join(runtime, "bus")]);
  return runtime;
};

describe("deployment prerequisites are stated at the top (README and OVERVIEW)", () => {
  it.each([
    ["unsandboxed, as the daemon user", /unsandboxed, as the daemon user/i],
    ["supported layout is PROPOSED and the owner's decision", /PROPOSED, the owner's decision until confirmed/],
    ["one dedicated unix user for Meute and the daemon", /Meute and the operator Paseo daemon run as (\*\*)?one dedicated unix user/],
    ["no third-party plugins, no other humans or services", /no third-party plugins,? (and )?no other humans,? (no other |or )services/],
    ["tailnet/VPN only", /tailnet or a VPN only/],
    ["writing the tree is a prerequisite, not enforced", /prerequisite, not (enforced by the plugin|something the plugin can enforce)/],
    ["settings are writable by any daemon.manage client", /(settings are|settings can be) writ\w+ by any client with `?daemon\.manage/i],
    ["same uid isolates nothing", /second daemon under the same unix user isolates nothing/],
    ["timer health needs the daemon user to own the bus", /timer health works only when the daemon user owns (the|that) user bus/i],
  ])("%s", (_label, pattern) => {
    expect(head(README, 40)).toMatch(pattern);
    expect(head(OVERVIEW, 3)).toMatch(pattern);
  });

  it("the group layout is gone, and the reason cites meute's umask 077 lines", () => {
    for (const text of [README, OVERVIEW]) expect(text).not.toMatch(/2770|chgrp|g\+rwX|separate unix user/);
    expect(flat(README)).toMatch(/umask 077` \(`bin\/meute:87`, `bin\/run\.sh:54`\)/);
  });

  const real = realMeuteSource();
  it.skipIf("skip" in real)(`the cited meute lines say what the README says ${"skip" in real ? `[SKIPPED: ${real.skip}]` : ""}`, () => {
    const source = (real as { source: string }).source;
    expect(readFileSync(join(source, "bin/meute"), "utf8").split("\n")[86]).toMatch(/^umask 077$/);
    expect(readFileSync(join(source, "bin/run.sh"), "utf8").split("\n")[53]).toMatch(/umask 077/);
    expect(readFileSync(join(source, "lib/health.sh"), "utf8").split("\n").slice(56, 58).join("\n")).toMatch(/HOME\/\.config\}\/systemd\/user\/meute-daily\.timer[\s\S]*STATE_DIR/);
  });

  it("no host names or personal paths ship", () => {
    for (const text of [README, OVERVIEW]) expect(text).not.toMatch(/\balto\b|\/var\/home\/user|05b-/);
  });
});

describe("each enforcement claim in the README holds in the code", () => {
  it("binary and directory chain: not group/other writable; the binary may be owned by root", async () => {
    expect(flat(README)).toMatch(/a regular executable owned by the daemon user or root and not group\/other writable/);
    const box = sandbox();
    chmodSync(join(box.root, "bin"), 0o775);
    expect(await refused(box.config)).toBe(true);
    const install = sandbox();
    const parent = join(install.dir, "root-owned-install");
    mkdirSync(parent);
    renameSync(install.root, join(parent, "root"));
    expect(await refused({ meuteRoot: join(parent, "root"), meutePath: join(parent, "root", "bin", "meute") })).toBe(false);
  });

  it("MEUTE_ROOT itself gets the entry rule: sticky is no exemption for it (above it, sticky is)", async () => {
    expect(flat(README)).toMatch(/MEUTE_ROOT itself gets the same rule as every entry of the tree: owned by the daemon user or root and not group\/other writable, and the sticky bit is no exemption for it/);
    expect(flat(OVERVIEW)).toMatch(/re-checks the binary, MEUTE_ROOT and the whole Meute code tree, and refuses any of them owned by another user or writable by group or others; a directory above MEUTE_ROOT must be owned by the daemon user or root and not writable by group or others unless it has the sticky bit/);
    const box = sandbox();
    chmodSync(box.root, 0o1777);
    expect(await checkExecutable(box.config)).toEqual({ ok: false, message: "Unsafe configuration: MEUTE_ROOT itself is writable by group or others" });
    chmodSync(box.root, 0o755);
    const parent = join(box.dir, "sticky");
    mkdirSync(parent);
    chmodSync(parent, 0o1777);
    renameSync(box.root, join(parent, "root"));
    expect(await refused({ meuteRoot: join(parent, "root"), meutePath: join(parent, "root", "bin", "meute") })).toBe(false);
  });

  it("a refusal names the entry relative to MEUTE_ROOT, never a host path", async () => {
    expect(flat(README)).toMatch(/A refusal names the entry relative to MEUTE_ROOT \(for example `\.\.\. writable by group or others: lib\/health\.sh`, sanitized\), never a host path/);
    const box = sandbox();
    mkdirSync(join(box.root, "lib"));
    writeFileSync(join(box.root, "lib", "health.sh"), "");
    chmodSync(join(box.root, "lib", "health.sh"), 0o666);
    const result = await checkExecutable(box.config);
    expect(result).toEqual({ ok: false, message: "Unsafe configuration: an entry of the Meute code tree is writable by group or others: lib/health.sh" });
  });

  it("sticky exempts only the writable rule, never the owner check", async () => {
    expect(flat(README)).toMatch(/The sticky bit exempts a directory above MEUTE_ROOT only from the not-group\/other-writable rule, never from the owner check/);
    const box = sandbox();
    const parent = join(box.dir, "foreign-owner");
    mkdirSync(parent);
    chmodSync(parent, 0o1755);
    renameSync(box.root, join(parent, "root"));
    const root = join(parent, "root");
    expect(await refused({ meuteRoot: root, meutePath: join(root, "bin", "meute") })).toBe(true);
  });

  it("the whole code tree is walked (lib/, __pycache__, tasks/, repos.yaml, .git/config)", async () => {
    expect(flat(README)).toMatch(/The whole Meute code tree is walked: every entry under MEUTE_ROOT \(`bin\/`, `lib\/` including `__pycache__`, `tasks\/`, `repos\.yaml`, `\.git\/config`/);
    expect(flat(README)).toMatch(/`\.git\/config` and hooks/);
    for (const [rel, kind] of [["lib/health.sh", "file"], ["lib/__pycache__/x.pyc", "file"], ["tasks", "dir"], ["repos.yaml", "file"], [".git/config", "file"], [".git/hooks/pre-commit", "file"]] as const) {
      const box = sandbox();
      mkdirSync(join(box.root, dirname(rel)), { recursive: true });
      if (kind === "dir") mkdirSync(join(box.root, rel));
      else writeFileSync(join(box.root, rel), "");
      expect(await refused(box.config), `${rel} at 0644/0755`).toBe(false);
      chmodSync(join(box.root, rel), kind === "dir" ? 0o777 : 0o666);
      expect(await refused(box.config), `${rel} writable by others`).toBe(true);
    }
  });

  it("the tree holds only regular files and directories owned by the daemon user or root", async () => {
    expect(flat(README)).toMatch(/must be a regular file or a directory \(no symlink, FIFO, socket or device\), owned by the daemon user or root/);
    const link = sandbox();
    mkdirSync(join(link.root, "lib"));
    symlinkSync("/etc/hostname", join(link.root, "lib", "x.sh"));
    expect(await refused(link.config)).toBe(true);
    const foreign = sandbox();
    mkdirSync(join(foreign.root, "lib"));
    writeFileSync(join(foreign.root, "lib", "foreign-owner"), "");
    expect(await refused(foreign.config)).toBe(true);
  });

  it("only state/, reports/, .worktrees/ and git data are skipped", async () => {
    expect(flat(README)).toMatch(/Not walked: `state\/`, `reports\/`, `\.worktrees\/` at the top \(data meute writes\) and `\.git\/objects`, `\.git\/refs`, `\.git\/logs`/);
    const box = sandbox();
    chmodSync(join(box.root, "state"), 0o777);
    expect(await refused(box.config)).toBe(false);
  });

  it("the entry cap in the README is the one in the code, and it fails closed", async () => {
    const stated = /More than ([\d ]+) entries fails closed/.exec(flat(README))?.[1]?.replace(/ /g, "");
    expect(Number(stated)).toBe(MAX_TREE_ENTRIES);
    const box = sandbox();
    expect((await checkCodeTree(box.root, process.getuid?.() ?? 0, 1)).ok).toBe(false);
  });

  it("PATH directories are checked", async () => {
    expect(flat(README)).toMatch(/Each configured PATH directory is a real directory \(no symlink\) owned by the daemon user or root, not group\/other writable/);
    const box = sandbox();
    const tools = join(box.dir, "tools");
    mkdirSync(tools);
    chmodSync(tools, 0o775);
    expect(await refused({ ...box.config, runnerPath: tools })).toBe(true);
  });

  it("HOME is always a private, empty 0700 directory, re-verified every call; there is no HOME setting", async () => {
    expect(flat(README)).toMatch(/`HOME` is always a \*\*private, empty directory\*\* the plugin makes with `mkdtemp` in the daemon's temp dir: owned by the daemon user, mode 0700, re-verified \(and replaced if changed or non-empty\) before every spawn/);
    expect(flat(README)).toMatch(/There is no HOME setting/);
    expect(fleetSettings.schema.parse({ homeDir: "/home/op" })).not.toHaveProperty("homeDir"); // "a stored homeDir is ignored"
    const box = sandbox("env");
    const home = (await envOf(box.config)).get("HOME") ?? "";
    const info = lstatSync(home);
    expect([info.uid, info.mode & 0o7777, readdirSync(home).length]).toEqual([process.getuid?.(), 0o700, 0]);
    chmodSync(home, 0o755);
    expect((await envOf(box.config)).get("HOME")).not.toBe(home);
  });

  it("a refused private HOME is removed at once and the error is the README's sentence; replaced HOMEs are removed", async () => {
    const stated = /`(No private HOME could be made for Meute: [^`]+)`/.exec(flat(README))?.[1];
    expect(stated).toBeDefined();
    expect(flat(README)).toMatch(/A replaced HOME is removed \(recursively only while it is still a 0700 directory of the daemon user, otherwise only if empty\), and the current one when the daemon process exits/);
    const box = sandbox("env");
    const home = (await envOf(box.config)).get("HOME")!;
    writeFileSync(join(home, "written"), "");
    const next = (await envOf(box.config)).get("HOME")!;
    expect([next !== home, existsSync(home)]).toEqual([true, false]);
    chmodSync(next, 0o755); // force a new one, in a temp dir under a 0777 parent
    const open = join(box.dir, "open");
    mkdirSync(join(open, "tmp"), { recursive: true, mode: 0o700 });
    chmodSync(open, 0o777);
    const saved = process.env["TMPDIR"];
    process.env["TMPDIR"] = join(open, "tmp");
    try {
      expect(await runAllowlisted(box.config, "health")).toMatchObject({ ok: false, message: stated });
      expect(readdirSync(join(open, "tmp"))).toEqual([]);
    } finally {
      process.env["TMPDIR"] = saved;
    }
  });

  it("the python/git isolation variables are the ones listed", async () => {
    const listed = flat(README).match(/`PYTHONNOUSERSITE=1`, `PYTHONDONTWRITEBYTECODE=1`, `GIT_CONFIG_GLOBAL=\/dev\/null`, `GIT_CONFIG_NOSYSTEM=1`/);
    expect(listed).not.toBeNull();
    const env = await envOf(sandbox("env").config);
    for (const pair of listed![0].match(/[A-Z_]+=[^`]+/g)!) expect(`${pair.split("=")[0]}=${env.get(pair.split("=")[0]!)}`).toBe(pair);
    const home = env.get("HOME")!;
    expect([env.get("XDG_CONFIG_HOME"), env.get("XDG_DATA_HOME"), env.get("XDG_CACHE_HOME")].every((v) => v?.startsWith(`${home}/`))).toBe(true);
  });

  it("XDG_RUNTIME_DIR is passed only with a live bus (a dead socket is left out)", async () => {
    expect(flat(README)).toMatch(/holding a `bus` socket owned by the daemon user that accepts a connection within 1 s\. Otherwise it is left out/);
    expect(read("server/session.ts")).toMatch(/const BUS_CONNECT_TIMEOUT_MS = 1_000;/);
    const box = sandbox("env");
    expect((await envOf({ ...box.config, xdgRuntimeDir: deadBus(box.dir) })).has("XDG_RUNTIME_DIR")).toBe(false);
  });

  it("health is never healthy without a live bus, and relies on the runner's report, not a probe of its own", async () => {
    expect(flat(README)).toMatch(/a leftover `bus` socket of a dead user manager is refused by the connect/);
    expect(flat(README)).toMatch(/the runner's report that this very child was given XDG_RUNTIME_DIR \(the check above, including the connect, made right before its spawn; health makes no bus probe of its own\)/);
    const box = makeFixtureRoot();
    cleanup.push(box.cleanup);
    expect(await health({ ...box.config, xdgRuntimeDir: deadBus(box.dir) })).toMatchObject({ ok: true, data: { state: "unknown" } });
    const runtime = join(box.dir, "live");
    mkdirSync(runtime, { mode: 0o700 });
    let connections = 0;
    const bus = createServer((socket) => { connections += 1; socket.destroy(); });
    await new Promise<void>((resolve) => bus.listen(join(runtime, "bus"), resolve));
    try {
      expect(await health({ ...box.config, xdgRuntimeDir: runtime })).toMatchObject({ ok: true, data: { state: "healthy" } });
      expect(connections).toBe(1);
    } finally {
      await new Promise<void>((resolve) => bus.close(() => resolve()));
    }
  });

  it("test HOME safety: HOME under the test root, and fs-guard refuses changes outside it", () => {
    expect(flat(README)).toMatch(/`tests\/fs-guard\.ts` makes chmod\/chown\/rm\/rmdir\/rename\/unlink \(sync, callback and promises\) throw for any real path outside the root/);
    expect(flat(README)).toMatch(/refuse to start unless HOME really \(by realpath\) lies under it and is not your home/);
    expect(() => assertTestHome(process.env["HOME"])).not.toThrow();
    expect(() => chmodSync(dirname(testRoot()), 0o700)).toThrow(/fs-guard/); // the test root's parent: outside, harmless
  });

  it("no daemon variable reaches the child", async () => {
    expect(flat(README)).toMatch(/No daemon variable reaches the child/);
    process.env["FLEET_DOCS_CANARY"] = "canary";
    try {
      expect((await envOf(sandbox("env").config)).has("FLEET_DOCS_CANARY")).toBe(false);
    } finally {
      delete process.env["FLEET_DOCS_CANARY"];
    }
  });
});

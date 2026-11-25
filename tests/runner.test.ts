import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOWLIST,
  buildEnv,
  effectiveTimeoutMs,
  MAX_TIMEOUT_MS,
  runAllowlisted,
} from "../server/runner";
import { makeSandbox, RECORD_ARGS, type Sandbox } from "./helpers";

let box: Sandbox | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
});

const ALLOWED_IDS = Object.keys(ALLOWLIST);

describe("allowlist table", () => {
  it("is exactly the three read-only commands with fixed argv", () => {
    expect(Object.fromEntries(Object.entries(ALLOWLIST).map(([id, spec]) => [id, spec.argv]))).toEqual({
      findings_list: ["findings", "--all", "--json"],
      health: ["health"],
      readiness_validate: ["readiness", "validate", "{record}", "--owner-policy", "{policy}"],
    });
  });

  it("is frozen", () => {
    expect(Object.isFrozen(ALLOWLIST)).toBe(true);
    expect(() => {
      (ALLOWLIST as Record<string, unknown>)["extra"] = { argv: ["show"] };
    }).toThrow();
  });

  it("never contains a mutating subcommand or flag", () => {
    const banned = new Set(["show", "verify", "--prune", "resolve", "dismiss", "promote", "claim",
      "run", "drain", "enqueue", "--enqueue", "plan", "install-timers", "timers", "--fix",
      "pause", "resume", "policy", "evidence", "branches", "doctor", "status", "reports", "web", "tui", "discover"]);
    for (const spec of Object.values(ALLOWLIST)) {
      for (const token of spec.argv) expect(banned.has(token)).toBe(false);
    }
  });
});

describe("denylist: every mutating or side-effecting meute command is unreachable", () => {
  const DENIED = [
    "show", "findings verify", "findings_verify", "findings --verify", "branches --prune", "branches_prune",
    "branches", "resolve", "dismiss", "promote", "claim", "run", "drain", "enqueue", "plan", "plan --enqueue",
    "timers", "install-timers", "install-statusline", "doctor --fix", "doctor", "image bump", "container probe",
    "discover", "pause", "resume", "policy set", "policy", "evidence export", "reports", "status", "tui", "web",
    "findings", "findings --new", "FINDINGS_LIST", " findings_list", "findings_list ", "findings_list; touch x",
    "findings_list\n", "findings_list\0", "", "__proto__", "constructor", "toString", "hasOwnProperty",
    "prototype", "valueOf", "../findings_list", "bin/meute",
  ];

  it.each(DENIED)("refuses command id %j without spawning", async (id) => {
    box = makeSandbox(RECORD_ARGS);
    const result = await runAllowlisted(box.config, id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("invalid_input");
    expect(existsSync(box.argsFile)).toBe(false);
  });

  it("refuses non-string command ids", async () => {
    box = makeSandbox(RECORD_ARGS);
    for (const id of [undefined, null, 5, {}, ["findings_list"]]) {
      const result = await runAllowlisted(box.config, id as unknown as string);
      expect(result.ok).toBe(false);
    }
    expect(existsSync(box.argsFile)).toBe(false);
  });

  it("refuses extra params on argv-free commands", async () => {
    box = makeSandbox(RECORD_ARGS);
    for (const id of ["findings_list", "health"]) {
      const result = await runAllowlisted(box.config, id, { flag: "--prune" });
      expect(result.ok).toBe(false);
    }
    expect(existsSync(box.argsFile)).toBe(false);
  });
});

describe("parameter injection", () => {
  const record = "/records/a record.json";
  const policy = "/records/policy.json";

  const BAD = [
    "1; rm -rf /", "--flag", "-h", "../etc/passwd", "/ok/../etc/passwd", "relative/path.json", "",
    "/a\nb.json", "/a\0b.json", "/a\rb.json", `/${"a".repeat(2000)}`, "/trailing/", "//double", "/./dot",
    "/x‮.json", "/tab\t.json", "$(touch pwn)", "`touch pwn`",
  ];

  it.each(BAD)("rejects readiness param %j", async (bad) => {
    box = makeSandbox(RECORD_ARGS);
    for (const params of [{ record: bad, policy }, { record, policy: bad }]) {
      const result = await runAllowlisted(box.config, "readiness_validate", params);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("invalid_input");
    }
    expect(existsSync(box.argsFile)).toBe(false);
  });

  it("rejects missing, extra and non-string params", async () => {
    box = makeSandbox(RECORD_ARGS);
    const cases: Array<Record<string, unknown> | undefined> = [
      undefined, {}, { record }, { policy }, { record, policy, extra: "/x" },
      { record: 5, policy }, { record, policy: null }, { record: ["/a"], policy },
    ];
    for (const params of cases) {
      const result = await runAllowlisted(box.config, "readiness_validate", params as Record<string, string>);
      expect(result.ok).toBe(false);
    }
    expect(existsSync(box.argsFile)).toBe(false);
  });

  it("passes valid paths with spaces and unicode through argv unchanged (no shell)", async () => {
    box = makeSandbox(RECORD_ARGS);
    const unicode = "/records/é ; $HOME `x` {a,b}.json";
    const result = await runAllowlisted(box.config, "readiness_validate", { record: unicode, policy });
    expect(result.ok).toBe(true);
    const argv = readFileSync(box.argsFile, "utf8").split("\0").filter((x) => x !== "\n").map((x) => x.replace(/^\n/, ""));
    expect(argv.slice(0, 5)).toEqual(["readiness", "validate", unicode, "--owner-policy", policy]);
  });

  it("issues exactly the fixed argv for each allowlisted id", async () => {
    box = makeSandbox(RECORD_ARGS);
    for (const id of ["findings_list", "health"]) await runAllowlisted(box.config, id);
    const lines = readFileSync(box.argsFile, "utf8").split("\n").filter(Boolean).map((l) => l.split("\0").filter(Boolean));
    expect(lines).toEqual([["findings", "--all", "--json"], ["health"]]);
  });
});

describe("environment scrubbing", () => {
  // Set here, so the test does not depend on what the developer's or CI's environment happens to hold.
  const CANARIES = [
    "SSH_AUTH_SOCK", "BASH_ENV", "ENV", "LD_PRELOAD", "PYTHONPATH", "PYTHONSTARTUP", "MEUTE_TEST", "MEUTE_NOW",
    "MEUTE_DECISIONS_FAIL_AFTER", "MEUTE_MANIFEST", "GIT_DIR", "GIT_CONFIG_PARAMETERS", "AWS_ACCESS_KEY_ID",
    "SECRET_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "PASEO_PASSWORD", "NODE_OPTIONS",
  ];

  it("never passes daemon variables to the child (canaries set by the test itself)", async () => {
    const saved = new Map(CANARIES.map((name) => [name, process.env[name]]));
    for (const name of CANARIES) process.env[name] = name === "LD_PRELOAD" || name === "BASH_ENV" || name === "ENV" ? "/nonexistent/canary" : `canary-${name}`;
    try {
      box = makeSandbox("env");
      const result = await runAllowlisted(box.config, "health");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.stdout).not.toMatch(/canary/);
      const keys = result.stdout.split("\n").filter(Boolean).map((l) => l.split("=")[0] ?? "");
      for (const name of CANARIES) expect(keys).not.toContain(name);
      const shellAdded = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);
      const unexpected = keys.filter((k) => !shellAdded.has(k) && !(k in buildEnv(box!.config, "/h")));
      expect(unexpected).toEqual([]);
      expect(result.stdout).toMatch(/^MEUTE_ROOT=.*meute root$/m);
      expect(result.stdout).toMatch(/^LC_ALL=C\.UTF-8$/m);
      expect(result.stdout).toMatch(/^PYTHONDONTWRITEBYTECODE=1$/m);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("buildEnv has a fixed minimal key set", () => {
    box = makeSandbox("true");
    expect(Object.keys(buildEnv(box.config, "/h")).sort()).toEqual([
      "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "HOME", "LC_ALL", "MEUTE_ROOT", "PATH", "PYTHONDONTWRITEBYTECODE",
      "PYTHONNOUSERSITE", "USER", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    ].sort());
    const env = buildEnv({ ...box.config, runnerPath: "/opt/bin:/usr/bin" }, "/h", "/run/user/1000");
    expect(env["XDG_RUNTIME_DIR"]).toBe("/run/user/1000");
    expect(env["HOME"]).toBe("/h");
    expect(env["PATH"]).toBe("/opt/bin:/usr/bin");
  });

  it("runs in MEUTE_ROOT with a private HOME", async () => {
    box = makeSandbox('pwd; echo "HOME=$HOME"');
    const result = await runAllowlisted(box.config, "health");
    expect(result.ok && result.stdout.split("\n")[0]).toBe(box.root);
    expect(result.ok && result.stdout).toMatch(/HOME=.*\/meute-fleet-home-/);
  });
});

describe("timeout, size cap, exit mapping", () => {
  it("clamps the timeout to 20 s", () => {
    box = makeSandbox("true");
    expect(MAX_TIMEOUT_MS).toBe(20_000);
    expect(effectiveTimeoutMs({ ...box.config, timeoutMs: 600_000 })).toBe(20_000);
    expect(effectiveTimeoutMs({ ...box.config, timeoutMs: -5 })).toBe(15_000);
    expect(effectiveTimeoutMs({ ...box.config, timeoutMs: 0 })).toBe(15_000);
    expect(effectiveTimeoutMs(box.config)).toBeLessThanOrEqual(20_000);
  });

  it("kills a hung command and its descendants after the timeout", async () => {
    // The pid is written before anything else, and the test waits for it, so a loaded host cannot
    // make the deadline fire before the descendant exists.
    box = makeSandbox('sleep 60 & echo $! > "$(dirname "$MEUTE_ROOT")/child.pid"; wait');
    const pidFile = join(box.dir, "child.pid");
    const started = Date.now();
    const pending = runAllowlisted({ ...box.config, timeoutMs: 3000, graceMs: 200 }, "health");
    while (!existsSync(pidFile) && Date.now() - started < 2500) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(pidFile)).toBe(true);
    const result = await pending;
    expect(Date.now() - started).toBeLessThan(8000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("timeout");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    box = makeSandbox("trap '' TERM; while true; do sleep 0.1; done");
    const started = Date.now();
    const result = await runAllowlisted({ ...box.config, timeoutMs: 200, graceMs: 200 }, "health");
    expect(Date.now() - started).toBeLessThan(5000);
    expect(!result.ok && result.code).toBe("timeout");
  });

  it("flags truncation instead of buffering unbounded output", async () => {
    box = makeSandbox("yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const result = await runAllowlisted({ ...box.config, maxOutputBytes: 4096 }, "findings_list");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("truncated");
      expect((result.stdout ?? "").length).toBeLessThanOrEqual(4096);
    }
  });

  it("caps stderr too", async () => {
    box = makeSandbox("yes bbbbbbbbbbbb >&2");
    const result = await runAllowlisted({ ...box.config, maxOutputBytes: 4096 }, "health");
    expect(!result.ok && result.code).toBe("truncated");
  });

  it("accepts exit 1 for health and exit 0/1/2 for readiness, rejects the rest", async () => {
    box = makeSandbox('exit "$(cat "$(dirname "$MEUTE_ROOT")/code")"');
    const paths = { record: "/r.json", policy: "/p.json" };
    const run = async (id: string, code: number) => {
      writeFileSync(join(box!.dir, "code"), String(code));
      return runAllowlisted(box!.config, id, id === "readiness_validate" ? paths : undefined);
    };
    expect((await run("health", 1)).ok).toBe(true);
    expect((await run("health", 2)).ok).toBe(false);
    expect((await run("findings_list", 1)).ok).toBe(false);
    for (const code of [0, 1, 2]) expect((await run("readiness_validate", code)).ok).toBe(true);
    const bad = await run("readiness_validate", 3);
    expect(!bad.ok && bad.code).toBe("exit_nonzero");
    const killed = await run("findings_list", 137);
    expect(!killed.ok && killed.code).toBe("exit_nonzero");
  });

  it("reports a missing binary as unavailable without leaking paths", async () => {
    box = makeSandbox("true");
    const missing = { ...box.config, meutePath: join(box.root, "bin", "meute"), meuteRoot: box.root };
    box.cleanup();
    const result = await runAllowlisted(missing, "health");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain("/");
    box = undefined;
  });

  it("refuses a meutePath that is not <root>/bin/meute", async () => {
    box = makeSandbox(RECORD_ARGS);
    const result = await runAllowlisted({ ...box.config, meutePath: "/usr/bin/true" }, "health");
    expect(!result.ok && result.code).toBe("invalid_config");
    expect(!result.ok && result.message).toMatch(/must be <MEUTE_ROOT>\/bin\/meute/);
    expect(existsSync(box.argsFile)).toBe(false);
  });

  it("does not leak the host path or environment in a failure message", async () => {
    box = makeSandbox('echo "boom at $MEUTE_ROOT/state/x $SECRET" >&2; exit 1');
    const result = await runAllowlisted(box.config, "findings_list");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain(box.root);
      expect(result.message).not.toContain("boom");
      expect(JSON.stringify(result.message)).not.toContain("/");
    }
  });

  it("ids come from a fixed table", () => {
    expect(ALLOWED_IDS.sort()).toEqual(["findings_list", "health", "readiness_validate"]);
  });
});

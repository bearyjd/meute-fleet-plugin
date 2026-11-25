// The ONLY module in this plugin that may spawn a process (enforced by tests/structure.test.ts).
//
// Safety model:
//  - commands come from a frozen ALLOWLIST table: command id -> exact argv template;
//  - the only interpolated values are absolute paths that passed isSafeAbsolutePath;
//  - the child is exec'd directly (shell: false), never through a shell;
//  - the environment is built from scratch, nothing is inherited from the daemon; HOME is a
//    private empty directory and XDG_RUNTIME_DIR is passed only while it is safe (session.ts);
//  - cwd is MEUTE_ROOT; timeout, output size and exit codes are bounded and mapped to
//    structured results that carry no host paths;
//  - the promise settles by a hard deadline whatever the descendants do with the pipes, and at
//    most MAX_CONCURRENT children run at once.
import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { ErrorCode } from "../shared/contracts";
import { checkExecutable, type SafetyCheck } from "./config";
import { checkRuntimeDir, PRIVATE_HOME_UNAVAILABLE, privateHome } from "./session";
import { isSafeAbsolutePath, isSafePathList } from "../shared/validate";

export interface RunnerConfig {
  readonly meutePath: string;
  readonly meuteRoot: string;
  readonly runnerPath?: string;
  readonly xdgRuntimeDir?: string;
  readonly timeoutMs?: number;
  readonly graceMs?: number;
  readonly maxOutputBytes?: number;
}

interface CommandSpec {
  readonly argv: readonly string[];
  /** Placeholders in argv, each filled by a validated absolute path. */
  readonly slots: readonly string[];
  /** Exit codes that carry data (readiness 1/2, health 1). Anything else is an error. */
  readonly okExitCodes: readonly number[];
}

export type CommandId = "findings_list" | "health" | "readiness_validate";

export const ALLOWLIST: Readonly<Record<CommandId, CommandSpec>> = Object.freeze({
  findings_list: Object.freeze({
    argv: Object.freeze(["findings", "--all", "--json"]),
    slots: Object.freeze([]),
    okExitCodes: Object.freeze([0]),
  }),
  health: Object.freeze({
    argv: Object.freeze(["health"]),
    slots: Object.freeze([]),
    okExitCodes: Object.freeze([0, 1]),
  }),
  readiness_validate: Object.freeze({
    argv: Object.freeze(["readiness", "validate", "{record}", "--owner-policy", "{policy}"]),
    slots: Object.freeze(["record", "policy"]),
    okExitCodes: Object.freeze([0, 1, 2]),
  }),
});

export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 20_000;
export const DEFAULT_GRACE_MS = 2_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
export const MAX_CONCURRENT = 4;
// After the leader exits, how long its pipes may stay open before a descendant holding them
// is treated as a failure. A clean exit closes them within milliseconds.
const DRAIN_MS = 2_000;
// Beyond timeout + grace: the promise settles at this point even if the pipes never close.
const SETTLE_MARGIN_MS = 500;
const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin";

export type RunOutcome =
  | {
      ok: true; exitCode: number; stdout: string; stderr: string; durationMs: number;
      /** ok only if this child was given XDG_RUNTIME_DIR, by the probe made right before its spawn (M3). */
      runtime: SafetyCheck;
    }
  | { ok: false; code: ErrorCode; message: string; exitCode?: number; stdout?: string; stderr?: string };

const fail = (code: ErrorCode, message: string, extra: object = {}): RunOutcome => ({
  ok: false,
  code,
  message,
  ...extra,
});

export function effectiveTimeoutMs(config: RunnerConfig): number {
  const requested = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(requested) || requested < 1) return DEFAULT_TIMEOUT_MS;
  return Math.min(requested, MAX_TIMEOUT_MS);
}

function currentUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "meute-fleet";
  }
}

/**
 * The complete child environment. Nothing else is inherited from the daemon. `home` is the
 * private HOME from session.ts; `runtimeDir` is XDG_RUNTIME_DIR only if it passed checkRuntimeDir.
 */
export function buildEnv(config: RunnerConfig, home: string, runtimeDir?: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: config.runnerPath && isSafePathList(config.runnerPath) ? config.runnerPath : DEFAULT_PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    USER: currentUser(),
    LC_ALL: "C.UTF-8",
    MEUTE_ROOT: config.meuteRoot,
    // meute's python helpers would otherwise write __pycache__ into the checkout.
    PYTHONDONTWRITEBYTECODE: "1",
    // No user site-packages (.pth / usercustomize) even if a HOME ever held them.
    PYTHONNOUSERSITE: "1",
    // For git run by meute directly; readiness.py strips GIT_* for its own git calls, where the
    // private HOME and XDG_CONFIG_HOME are what keep a user gitconfig out.
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  if (runtimeDir !== undefined && isSafeAbsolutePath(runtimeDir)) env["XDG_RUNTIME_DIR"] = runtimeDir;
  return env;
}

/**
 * Validated right before a spawn: the private HOME and, if safe now, XDG_RUNTIME_DIR. `runtime`
 * says whether the child gets XDG_RUNTIME_DIR, and why not; health relies on it, not on a probe of its own.
 */
async function prepareEnv(config: RunnerConfig): Promise<{ env: Record<string, string>; runtime: SafetyCheck } | null> {
  const home = await privateHome();
  if (home === null) return null;
  const probe = await checkRuntimeDir(config.xdgRuntimeDir);
  const env = buildEnv(config, home, probe.ok ? config.xdgRuntimeDir : undefined);
  const passed = env["XDG_RUNTIME_DIR"] !== undefined;
  const runtime: SafetyCheck = passed ? { ok: true }
    : probe.ok ? { ok: false, message: "Health cannot be verified: XDG_RUNTIME_DIR is not a valid path" } : probe;
  return { env, runtime };
}

function buildArgv(id: string, params: unknown): string[] | RunOutcome {
  if (typeof id !== "string" || !Object.hasOwn(ALLOWLIST, id)) {
    return fail("invalid_input", "Command is not allowed");
  }
  const spec = ALLOWLIST[id as CommandId];
  const given = params === undefined || params === null ? {} : params;
  if (typeof given !== "object" || Array.isArray(given)) return fail("invalid_input", "Invalid parameters");
  const keys = Object.keys(given);
  if (!keys.every((key) => spec.slots.includes(key))) {
    return fail("invalid_input", "Invalid parameters");
  }
  const values = given as Record<string, unknown>;
  const argv: string[] = [];
  for (const token of spec.argv) {
    if (!token.startsWith("{")) {
      argv.push(token);
      continue;
    }
    const value = values[token.slice(1, -1)];
    if (!isSafeAbsolutePath(value)) return fail("invalid_input", "Invalid parameter value");
    argv.push(value);
  }
  return argv;
}

const positive = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;

/**
 * Signals the child's process group. The bare pid is a fallback only while the leader has not
 * exited: once it has been reaped its pid may belong to an unrelated process. A group id cannot
 * be reallocated while any member lives; the residual window is a group that emptied and a new
 * session leader that got the same number between two lines of this function.
 */
function killGroup(pid: number | undefined, signal: NodeJS.Signals, leaderExited: boolean): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    if (leaderExited) return;
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

const inflight = new Map<string, Promise<RunOutcome>>();
let running = 0;

/** Runs one allowlisted command. Concurrent identical calls share one child. */
export function runAllowlisted(
  config: RunnerConfig,
  id: string,
  params?: Record<string, string>,
): Promise<RunOutcome> {
  const argv = buildArgv(id, params);
  if (!Array.isArray(argv)) return Promise.resolve(argv);
  // The configured environment is part of the key: a call after a settings change must not get
  // an answer computed with the old PATH/XDG_RUNTIME_DIR.
  const key = JSON.stringify([config.meutePath, argv, config.runnerPath ?? "", config.xdgRuntimeDir ?? "", effectiveTimeoutMs(config)]);
  const existing = inflight.get(key);
  if (existing) return existing;
  const started = (async () => {
    // Re-validated right before every spawn, not only when the settings were saved.
    const safety = await checkExecutable(config);
    if (!safety.ok) return fail("invalid_config", safety.message);
    const prepared = await prepareEnv(config);
    if (prepared === null) return fail("unavailable", PRIVATE_HOME_UNAVAILABLE);
    return execute(config, id, argv, prepared.env, prepared.runtime);
  })().finally(() => inflight.delete(key));
  inflight.set(key, started);
  return started;
}

function execute(config: RunnerConfig, id: string, argv: string[], env: Record<string, string>, runtime: SafetyCheck): Promise<RunOutcome> {
  const spec = ALLOWLIST[id as CommandId];
  const timeoutMs = effectiveTimeoutMs(config);
  const graceMs = positive(config.graceMs, DEFAULT_GRACE_MS);
  const cap = positive(config.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const began = Date.now();
  if (running >= MAX_CONCURRENT) {
    return Promise.resolve(fail("unavailable", "Too many Meute commands are running; try again shortly"));
  }

  return new Promise<RunOutcome>((resolve) => {
    let child;
    try {
      child = spawn(config.meutePath, argv, {
        shell: false,
        detached: true, // own process group, so a timeout can stop python/git/systemctl children
        stdio: ["ignore", "pipe", "pipe"],
        env,
        cwd: config.meuteRoot,
      });
    } catch {
      resolve(fail("unavailable", "Meute could not be started"));
      return;
    }
    running += 1;

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let exited = false;
    let settled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const later = (ms: number, task: () => void) => timers.push(setTimeout(task, ms));

    const stop = () => {
      killGroup(child.pid, "SIGTERM", exited);
      later(graceMs, () => killGroup(child.pid, "SIGKILL", exited));
    };

    const finish = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      running -= 1;
      for (const timer of timers) clearTimeout(timer);
      // Sweep stragglers that kept the group alive, then let go of the pipes: a descendant that
      // left the group must not keep this call (or its buffers) alive.
      killGroup(child.pid, "SIGKILL", exited);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(outcome);
    };
    const timeout = () => fail("timeout", "Meute did not answer in time");

    later(timeoutMs, () => {
      timedOut = true;
      stop();
    });
    later(timeoutMs + graceMs + SETTLE_MARGIN_MS, () => finish(timeout()));

    const collect = (chunks: Buffer[], size: number, chunk: Buffer): number => {
      const room = Math.max(0, cap - size);
      if (chunk.length > room) {
        truncated = true;
        if (room > 0) chunks.push(chunk.subarray(0, room));
        if (!timedOut) stop();
        return size + room;
      }
      chunks.push(chunk);
      return size + chunk.length;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (!truncated) outBytes = collect(out, outBytes, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (!truncated) errBytes = collect(err, errBytes, chunk);
    });

    child.on("error", () => finish(fail("unavailable", "Meute could not be started")));
    child.on("exit", () => {
      exited = true;
      later(DRAIN_MS, () =>
        finish(timedOut ? timeout() : fail("unavailable", "Meute exited but a background process kept its output open")));
    });
    child.on("close", (exitCode, signal) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (timedOut) return finish(timeout());
      if (truncated) return finish(fail("truncated", "Meute output exceeded the size limit", { stdout, stderr }));
      if (exitCode === null || !spec.okExitCodes.includes(exitCode)) {
        const how = exitCode === null ? `signal ${signal ?? "unknown"}` : `exit ${exitCode}`;
        return finish(fail("exit_nonzero", `Meute command failed (${how})`, { exitCode: exitCode ?? undefined }));
      }
      return finish({ ok: true, exitCode, stdout, stderr, durationMs: Date.now() - began, runtime });
    });
  });
}

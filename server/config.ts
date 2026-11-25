import { lstat, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FleetSettingsValues } from "../shared/settings";
import { isSafeAbsolutePath, isSafePathList } from "../shared/validate";
import type { Result } from "./parsers";
import type { RunnerConfig } from "./runner";
import { checkCodeTree } from "./tree";

export interface FleetConfig extends RunnerConfig {
  readonly readinessRecordPath?: string;
  readonly readinessPolicyPath?: string;
}

const refuse = (code: "not_configured" | "invalid_config", message: string): Result<FleetConfig> => ({
  ok: false,
  error: { code, message },
});

export type SafetyCheck = { ok: true } | { ok: false; message: string };

const unsafe = (reason: string): SafetyCheck => ({ ok: false, message: `Unsafe configuration: ${reason}` });
const WRITABLE_BY_OTHERS = 0o022;
const STICKY = 0o1000;
const daemonUid = (): number => process.getuid?.() ?? 0;

/**
 * Every directory from `start` up to "/" must be a real directory owned by the daemon user or
 * root (the owner of a directory can always move or replace its entries, sticky bit or not), and not
 * group/other writable unless the sticky bit is set (like /tmp, where others cannot move or
 * delete entries they do not own).
 */
export async function checkAncestors(start: string, uid: number): Promise<SafetyCheck> {
  for (let dir = start; ; dir = dirname(dir)) {
    const info = await lstat(dir);
    if (!info.isDirectory()) return unsafe("a parent of the Meute binary is not a directory");
    const sticky = (info.mode & STICKY) !== 0;
    if (!sticky && (info.mode & WRITABLE_BY_OTHERS) !== 0) {
      return unsafe("a directory above the Meute binary is writable by group or others");
    }
    if (info.uid !== uid && info.uid !== 0) {
      return unsafe("a directory above the Meute binary is owned by another user");
    }
    if (dir === "/") return { ok: true };
  }
}

/**
 * The allowlist pins argv; this pins the executable. Run before EVERY spawn (settings are written
 * by any client with daemon.manage, so they are input, not trusted configuration):
 *  - meutePath is exactly <meuteRoot>/bin/meute and no component of it is a symlink;
 *  - it is a regular executable file owned by the daemon user or root, not writable by group/other;
 *  - its directory chain cannot be changed by anyone else (see checkAncestors);
 *  - every entry of the Meute code tree passes checkCodeTree (meute sources lib/ and runs python);
 *  - each configured PATH directory is a real directory (no symlink), owned by the daemon user or
 *    root, and not writable by group/other (sticky does not help: others could add a new file).
 */
export async function checkExecutable(config: RunnerConfig, uid: number = daemonUid()): Promise<SafetyCheck> {
  if (!isSafeAbsolutePath(config.meuteRoot) || config.meutePath !== join(config.meuteRoot, "bin", "meute")) {
    return unsafe("the Meute binary must be <MEUTE_ROOT>/bin/meute");
  }
  try {
    if ((await realpath(config.meutePath)) !== config.meutePath) {
      return unsafe("the Meute binary path goes through a symbolic link");
    }
    const binary = await lstat(config.meutePath);
    if (!binary.isFile() || (binary.mode & 0o111) === 0) return unsafe("the Meute binary is not an executable file");
    if ((binary.mode & WRITABLE_BY_OTHERS) !== 0) return unsafe("the Meute binary is writable by group or others");
    if (binary.uid !== uid && binary.uid !== 0) return unsafe("the Meute binary is owned by another user");
    // The tree first: it holds bin/ and MEUTE_ROOT to the strict entry rule and names what failed;
    // the ancestor rule (sticky allowed) then covers only the directories above MEUTE_ROOT.
    const tree = await checkCodeTree(config.meuteRoot, uid);
    if (!tree.ok) return tree;
    const chain = await checkAncestors(dirname(config.meutePath), uid);
    if (!chain.ok) return chain;
    for (const dir of config.runnerPath ? config.runnerPath.split(":") : []) {
      if ((await realpath(dir)) !== dir) return unsafe("a PATH directory goes through a symbolic link");
      const info = await lstat(dir);
      if (!info.isDirectory()) return unsafe("a PATH entry is not a directory");
      if ((info.mode & WRITABLE_BY_OTHERS) !== 0) return unsafe("a PATH directory is writable by group or others");
      if (info.uid !== uid && info.uid !== 0) return unsafe("a PATH directory is owned by another user");
      const parents = dir === "/" ? ({ ok: true } as const) : await checkAncestors(dirname(dir), uid);
      if (!parents.ok) return unsafe("a directory above a PATH directory can be changed by others");
    }
  } catch {
    return unsafe("the Meute binary or a PATH directory cannot be inspected");
  }
  return { ok: true };
}

/**
 * Turns saved settings into a runner config. Nothing is discovered: an empty value means
 * "not configured". meute derives MEUTE_ROOT from its own location, so meutePath must be
 * exactly <root>/bin/meute, a plain executable file, or the CLI and the direct file reads
 * could look at different trees.
 */
export async function resolveConfig(values: FleetSettingsValues): Promise<Result<FleetConfig>> {
  if (values.meutePath === "" || values.meuteRoot === "") {
    return refuse("not_configured", "Set the Meute binary path and MEUTE_ROOT in the plugin settings");
  }
  if (!isSafeAbsolutePath(values.meutePath) || !isSafeAbsolutePath(values.meuteRoot)) {
    return refuse("invalid_config", "Meute paths must be clean absolute paths");
  }
  if (values.meutePath !== join(values.meuteRoot, "bin", "meute")) {
    return refuse("invalid_config", "The Meute binary must be <MEUTE_ROOT>/bin/meute");
  }
  for (const optional of [values.xdgRuntimeDir, values.readinessRecordPath, values.readinessPolicyPath]) {
    if (optional !== "" && !isSafeAbsolutePath(optional)) return refuse("invalid_config", "A configured path is not valid");
  }
  if (values.runnerPath !== "" && !isSafePathList(values.runnerPath)) {
    return refuse("invalid_config", "The runner PATH must list absolute directories");
  }
  try {
    const binary = await lstat(values.meutePath);
    if (!binary.isFile() || binary.isSymbolicLink() || (binary.mode & 0o111) === 0) {
      return refuse("invalid_config", "The Meute binary must be a plain executable file");
    }
    const root = await lstat(await realpath(values.meuteRoot));
    if (!root.isDirectory()) return refuse("invalid_config", "MEUTE_ROOT must be a directory");
  } catch {
    return refuse("invalid_config", "The Meute binary or MEUTE_ROOT does not exist");
  }
  const safety = await checkExecutable({
    meutePath: values.meutePath,
    meuteRoot: values.meuteRoot,
    ...(values.runnerPath !== "" ? { runnerPath: values.runnerPath } : {}),
  });
  if (!safety.ok) return refuse("invalid_config", safety.message);
  return {
    ok: true,
    data: {
      meutePath: values.meutePath,
      meuteRoot: values.meuteRoot,
      ...(values.runnerPath !== "" ? { runnerPath: values.runnerPath } : {}),
      ...(values.xdgRuntimeDir !== "" ? { xdgRuntimeDir: values.xdgRuntimeDir } : {}),
      ...(values.readinessRecordPath !== "" ? { readinessRecordPath: values.readinessRecordPath } : {}),
      ...(values.readinessPolicyPath !== "" ? { readinessPolicyPath: values.readinessPolicyPath } : {}),
    },
  };
}

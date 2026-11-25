// Per-call executable validation (review 06 runner F3): settings are client input, so the binary,
// its directory chain and the PATH directories are re-checked before every spawn.
import { chmodSync, existsSync, mkdirSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkExecutable, resolveConfig } from "../server/config";
import { runAllowlisted } from "../server/runner";
import { makeSandbox, RECORD_ARGS, type Sandbox } from "./helpers";

let box: Sandbox | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
});

const settingsFor = (b: Sandbox, extra: Record<string, string> = {}) => ({
  meutePath: b.config.meutePath, meuteRoot: b.config.meuteRoot, readinessRecordPath: "", readinessPolicyPath: "",
  runnerPath: "", xdgRuntimeDir: "", ...extra,
});

async function expectRefused(b: Sandbox, overrides: Record<string, string> = {}, reason: RegExp = /./) {
  const run = await runAllowlisted({ ...b.config, ...overrides }, "health");
  expect(run).toMatchObject({ ok: false, code: "invalid_config" });
  expect(!run.ok && run.message).toMatch(/^Unsafe configuration: /);
  expect(!run.ok && run.message).toMatch(reason);
  expect(!run.ok && run.message).not.toContain("/");
  expect(await resolveConfig(settingsFor(b, overrides))).toMatchObject({ ok: false, error: { code: "invalid_config" } });
  expect(existsSync(b.argsFile)).toBe(false);
}

describe("the meute executable is validated on every call", () => {
  it("accepts the plain sandbox (a sticky world-writable /tmp ancestor is allowed)", async () => {
    box = makeSandbox(RECORD_ARGS);
    expect(await checkExecutable(box.config)).toEqual({ ok: true });
    expect((await runAllowlisted(box.config, "health")).ok).toBe(true);
  });

  it.each([[0o775, "group"], [0o757, "other"]])("refuses a bin/meute writable by %s (mode %o)", async (mode) => {
    box = makeSandbox(RECORD_ARGS);
    chmodSync(box.meute, mode);
    await expectRefused(box, {}, /binary is writable/);
  });

  it("refuses a group-writable bin directory", async () => {
    box = makeSandbox(RECORD_ARGS);
    chmodSync(join(box.root, "bin"), 0o775);
    await expectRefused(box, {}, /an entry of the Meute code tree is writable by group or others: bin$/);
  });

  it("refuses an other-writable, non-sticky MEUTE_ROOT", async () => {
    box = makeSandbox(RECORD_ARGS);
    chmodSync(box.root, 0o777);
    await expectRefused(box, {}, /MEUTE_ROOT itself is writable by group or others/);
  });

  it("accepts a sticky world-writable ancestor but not a non-sticky one", async () => {
    box = makeSandbox(RECORD_ARGS);
    const shared = join(box.dir, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o1777);
    const root = join(shared, "root");
    renameSync(box.root, root);
    const config = { ...box.config, meuteRoot: root, meutePath: join(root, "bin", "meute") };
    expect(await checkExecutable(config)).toEqual({ ok: true });
    chmodSync(shared, 0o777);
    expect(await checkExecutable(config)).toMatchObject({ ok: false });
  });

  it("refuses a binary owned by another user", async () => {
    box = makeSandbox(RECORD_ARGS);
    const uid = process.getuid?.() ?? 0;
    expect(await checkExecutable(box.config, uid + 1)).toMatchObject({ ok: false, message: expect.stringMatching(/^Unsafe configuration: the Meute binary is owned/) });
  });

  it("refuses a symlinked MEUTE_ROOT and a symlinked bin directory (no link in any component)", async () => {
    box = makeSandbox(RECORD_ARGS);
    const linkRoot = join(box.dir, "link-root");
    symlinkSync(box.root, linkRoot);
    await expectRefused(box, { meuteRoot: linkRoot, meutePath: join(linkRoot, "bin", "meute") }, /symbolic link/);
    renameSync(join(box.root, "bin"), join(box.dir, "other-bin"));
    symlinkSync(join(box.dir, "other-bin"), join(box.root, "bin"));
    await expectRefused(box, {}, /symbolic link/);
  });

  it("re-checks on every call: a binary made writable after a good call is refused next time", async () => {
    box = makeSandbox(RECORD_ARGS);
    expect((await runAllowlisted(box.config, "health")).ok).toBe(true);
    chmodSync(box.meute, 0o777);
    const second = await runAllowlisted(box.config, "findings_list");
    expect(second).toMatchObject({ ok: false, code: "invalid_config" });
  });
});

describe("runner PATH directories are validated on every call", () => {
  it.each([
    ["group-writable", (dir: string) => chmodSync(dir, 0o775)],
    ["sticky world-writable (like /tmp)", (dir: string) => chmodSync(dir, 0o1777)],
  ])("refuses a %s PATH directory", async (_label, spoil) => {
    box = makeSandbox(RECORD_ARGS);
    const bin = join(box.dir, "tools");
    mkdirSync(bin, { mode: 0o755 });
    chmodSync(bin, 0o755);
    expect(await checkExecutable({ ...box.config, runnerPath: `${bin}:/usr/bin` })).toEqual({ ok: true });
    spoil(bin);
    await expectRefused(box, { runnerPath: `${bin}:/usr/bin` }, /PATH directory is writable/);
  });

  it("refuses a symlinked PATH directory and a missing one", async () => {
    box = makeSandbox(RECORD_ARGS);
    const bin = join(box.dir, "tools");
    mkdirSync(bin);
    chmodSync(bin, 0o755);
    symlinkSync(bin, join(box.dir, "tools-link"));
    await expectRefused(box, { runnerPath: `${join(box.dir, "tools-link")}:/usr/bin` }, /symbolic link/);
    await expectRefused(box, { runnerPath: `${join(box.dir, "missing")}:/usr/bin` });
  });
});

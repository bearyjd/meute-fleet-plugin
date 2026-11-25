// Ownership half of the executable guards (re-review 07: runner N1, tests M1 / RR04-RR06).
// Another uid cannot be created without privileges, so lstat is wrapped: any path with a
// last component named "foreign-owner" reports a uid that is neither the daemon user nor root.
// Every other path sees the real lstat, so the rest of the check runs for real.
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const FOREIGN = "foreign-owner";
const ROOT_OWNED = "root-owned-install";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const foreign = (path: unknown) => String(path).split("/").pop() === FOREIGN;
  // L2: a root-owned install (/opt/meute owned by root): bin/meute under a ROOT_OWNED dir reports uid 0.
  const rootOwned = (path: unknown) => String(path).includes(`/${ROOT_OWNED}/`) && String(path).endsWith("/bin/meute");
  const lstat = (async (path: string, options?: { bigint?: boolean }) => {
    const info = await real.lstat(path, options as never);
    if (rootOwned(path)) return new Proxy(info, { get: (target, key) => (key === "uid" ? (typeof target.uid === "bigint" ? 0n : 0) : Reflect.get(target, key) as unknown) });
    if (!foreign(path)) return info;
    return new Proxy(info, {
      get: (target, key) => {
        if (key !== "uid") return Reflect.get(target, key) as unknown;
        return typeof target.uid === "bigint" ? target.uid + 4242n : Number(target.uid) + 4242;
      },
    });
  }) as typeof real.lstat;
  return { ...real, lstat, default: { ...real, lstat } };
});

const { checkExecutable } = await import("../server/config");
const { makeSandbox, RECORD_ARGS } = await import("./helpers");

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

/** A sandbox whose root is moved under <dir>/<parentName>/root, with that parent at `mode`. */
function rootUnder(parentName: string, mode: number) {
  const box = makeSandbox(RECORD_ARGS);
  cleanup = box.cleanup;
  const parent = join(box.dir, parentName);
  mkdirSync(parent);
  chmodSync(parent, mode);
  const root = join(parent, "root");
  renameSync(box.root, root);
  return { box, root, config: { ...box.config, meuteRoot: root, meutePath: join(root, "bin", "meute") } };
}

describe("every directory above the binary must be owned by the daemon user or root", () => {
  it("control: the wrapper is inert for ordinary paths", async () => {
    const { config } = rootUnder("plain", 0o755);
    expect(await checkExecutable(config)).toEqual({ ok: true });
  });

  it("N1: a sticky directory owned by another user is refused (its owner can swap entries)", async () => {
    const { config } = rootUnder(FOREIGN, 0o1755);
    expect(await checkExecutable(config)).toEqual({
      ok: false,
      message: "Unsafe configuration: a directory above the Meute binary is owned by another user",
    });
  });

  it("N1: also a sticky world-writable one owned by another user", async () => {
    const { config } = rootUnder(FOREIGN, 0o1777);
    expect(await checkExecutable(config)).toMatchObject({ ok: false, message: expect.stringMatching(/owned by another user/) });
  });

  it("RR04: a non-sticky 0755 ancestor owned by another user is refused", async () => {
    const { config } = rootUnder(FOREIGN, 0o755);
    expect(await checkExecutable(config)).toMatchObject({ ok: false, message: expect.stringMatching(/owned by another user/) });
  });
});

describe("L2: root is accepted as the owner of bin/meute, as for every other checked entry", () => {
  it("a root-owned bin/meute passes; one owned by another user is still refused", async () => {
    const { config } = rootUnder(ROOT_OWNED, 0o755);
    expect(await checkExecutable(config)).toEqual({ ok: true });
    expect(await checkExecutable(config, (process.getuid?.() ?? 0) + 1)).toMatchObject({ ok: false });
  });
});

describe("M2: MEUTE_ROOT itself is held to the entry rule", () => {
  it("a MEUTE_ROOT owned by another user is refused, and the message says it is the root", async () => {
    const box = makeSandbox(RECORD_ARGS);
    cleanup = box.cleanup;
    const root = join(box.dir, FOREIGN);
    renameSync(box.root, root);
    expect(await checkExecutable({ ...box.config, meuteRoot: root, meutePath: join(root, "bin", "meute") })).toEqual({
      ok: false,
      message: "Unsafe configuration: MEUTE_ROOT itself is owned by another user",
    });
  });
});

describe("runner PATH directories and their parents", () => {
  it("RR05: a 0755 PATH directory owned by another user is refused", async () => {
    const box = makeSandbox(RECORD_ARGS);
    cleanup = box.cleanup;
    const bin = join(box.dir, FOREIGN);
    mkdirSync(bin);
    chmodSync(bin, 0o755);
    expect(await checkExecutable({ ...box.config, runnerPath: `${bin}:/usr/bin` })).toEqual({
      ok: false,
      message: "Unsafe configuration: a PATH directory is owned by another user",
    });
  });

  it("RR06: a PATH directory whose parent is world-writable (non-sticky) is refused", async () => {
    const box = makeSandbox(RECORD_ARGS);
    cleanup = box.cleanup;
    const parent = join(box.dir, "a");
    mkdirSync(join(parent, "bin"), { recursive: true });
    chmodSync(join(parent, "bin"), 0o755);
    chmodSync(parent, 0o755);
    expect(await checkExecutable({ ...box.config, runnerPath: join(parent, "bin") })).toEqual({ ok: true });
    chmodSync(parent, 0o777);
    expect(await checkExecutable({ ...box.config, runnerPath: join(parent, "bin") })).toEqual({
      ok: false,
      message: "Unsafe configuration: a directory above a PATH directory can be changed by others",
    });
  });
});

describe("the Meute code tree", () => {
  it("N2: a file in lib/ owned by another user is refused", async () => {
    const box = makeSandbox(RECORD_ARGS);
    cleanup = box.cleanup;
    mkdirSync(join(box.root, "lib"));
    writeFileSync(join(box.root, "lib", FOREIGN), "x=1\n");
    expect(await checkExecutable(box.config)).toEqual({
      ok: false,
      message: "Unsafe configuration: an entry of the Meute code tree is owned by another user: lib/foreign-owner",
    });
  });
});

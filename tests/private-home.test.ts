// The child's private HOME (re-review 08 M1, S1, S2): a temp dir that fails verification is
// removed again and the error names the cause; replaced HOMEs are removed, so polling does not
// pile up directories; ancestors and owner are checked.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSandbox, type Sandbox } from "./helpers";

// S2 needs a HOME owned by another uid while its ancestors pass: lstat reports a foreign owner
// for meute-fleet-home-* entries while `foreignHomes.on` is set (no privileges needed).
const foreignHomes = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const lstat = (async (path: string, options?: { bigint?: boolean }) => {
    const info = await real.lstat(path, options as never);
    if (!foreignHomes.on || !String(path).split("/").pop()!.startsWith("meute-fleet-home-")) return info;
    return new Proxy(info, { get: (target, key) => (key === "uid" ? Number(target.uid) + 4242 : Reflect.get(target, key) as unknown) });
  }) as typeof real.lstat;
  return { ...real, lstat, default: { ...real, lstat } };
});

type Session = typeof import("../server/session");
type Runner = typeof import("../server/runner");
const uid = process.getuid?.() ?? 0;
const savedTmp = process.env["TMPDIR"];
let box: Sandbox | undefined;
let session: Session;

beforeEach(async () => {
  vi.resetModules(); // a fresh module: no HOME carried over from another test
  session = await import("../server/session");
});
afterEach(() => {
  process.env["TMPDIR"] = savedTmp;
  foreignHomes.on = false;
  box?.cleanup();
  box = undefined;
});

const homes = (dir: string) => readdirSync(dir).filter((name) => name.startsWith("meute-fleet-home-"));

/** TMPDIR = <box>/<parentMode dir>/tmp (0700). */
function tempUnder(parentMode: number): string {
  box = makeSandbox("true");
  const parent = join(box.dir, "parent");
  mkdirSync(join(parent, "tmp"), { recursive: true, mode: 0o700 });
  chmodSync(parent, parentMode);
  process.env["TMPDIR"] = join(parent, "tmp");
  return join(parent, "tmp");
}

describe("a temp dir that fails verification", () => {
  it("S1: TMPDIR under a 0777 parent gives no HOME, and M1: three calls leave no directory", async () => {
    const temp = tempUnder(0o777);
    for (let call = 0; call < 3; call++) expect(await session.privateHome()).toBeNull();
    expect(homes(temp)).toEqual([]);
  });

  it("S2: a HOME not owned by the daemon user is refused and removed", async () => {
    const temp = tempUnder(0o700);
    for (let call = 0; call < 3; call++) expect(await session.privateHome(uid + 1)).toBeNull();
    expect(homes(temp)).toEqual([]);
    expect(await session.privateHome(uid)).not.toBeNull(); // the same TMPDIR works for the real owner
  });

  it("S2: a HOME owned by another user is refused even when every directory above it passes", async () => {
    const temp = tempUnder(0o700);
    foreignHomes.on = true;
    expect(await session.privateHome()).toBeNull();
    foreignHomes.on = false;
    expect(homes(temp)).toEqual([]);
  });

  it("the runner's error names the cause and what to set", async () => {
    tempUnder(0o777);
    const runner: Runner = await import("../server/runner");
    const result = await runner.runAllowlisted(box!.config, "health");
    expect(result).toMatchObject({ ok: false, code: "unavailable" });
    expect(!result.ok && result.message).toMatch(/temp dir \(TMPDIR, default \/tmp\).*owned by another user or open to others.*set TMPDIR/);
  });
});

describe("HOMEs do not pile up", () => {
  it("one HOME is shared while intact; a replaced one is removed", async () => {
    const temp = tempUnder(0o700);
    const first = (await session.privateHome())!;
    expect(await session.privateHome()).toBe(first);
    writeFileSync(join(first, ".gitconfig"), ""); // the child wrote into it
    const second = (await session.privateHome())!;
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(false);
    chmodSync(second, 0o755); // changed mode, still empty
    const third = (await session.privateHome())!;
    expect(existsSync(second)).toBe(false);
    expect(homes(temp)).toEqual([third.split("/").pop()]);
  });

  it("a replaced HOME that is neither private nor empty is left alone (it may hold another user's files)", async () => {
    const temp = tempUnder(0o700);
    const first = (await session.privateHome())!;
    writeFileSync(join(first, "planted"), "");
    chmodSync(first, 0o777);
    await session.privateHome();
    expect(existsSync(join(first, "planted"))).toBe(true);
    expect(homes(temp).length).toBe(2);
  });

  it("the HOME is removed when the process exits", async () => {
    const temp = tempUnder(0o700);
    const home = (await session.privateHome())!;
    writeFileSync(join(home, "x"), "");
    expect(process.listeners("exit")).toContain(session.removePrivateHomes);
    session.removePrivateHomes();
    expect(homes(temp)).toEqual([]);
    expect(lstatSync(temp).isDirectory()).toBe(true);
    process.removeListener("exit", session.removePrivateHomes);
  });
});

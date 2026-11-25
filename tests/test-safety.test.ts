// The test harness can never change the real home (re-review 08 H1: a mutation run once chmod'ed
// the developer's home). Targets used here are harmless: files made outside the test root in
// FLEET_TEST_TMPDIR, never the real home (only the pure path checks are given the real home path).
import { chmodSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { chmod, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allowOutsideTestRoot, assertPrivateTestHome, assertTestHome, testRoot } from "./helpers";

const root = testRoot();
const XDG = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR"];

describe("vitest.config.ts puts HOME and the XDG dirs in 0700 dirs under the test root", () => {
  it.each(["HOME", ...XDG])("%s", (name) => {
    const dir = assertTestHome(process.env[name], root);
    const info = lstatSync(dir);
    expect([info.isDirectory(), info.uid, info.mode & 0o777]).toEqual([true, process.getuid?.(), 0o700]);
  });
});

describe("the HOME checks compare real paths", () => {
  it("the real home is refused", () => {
    expect(() => assertTestHome(userInfo().homedir, root)).toThrow(/not a test HOME/);
    // Even with a (misconfigured) test root above it: pure path checks, nothing is changed.
    const realHome = realpathSync(userInfo().homedir);
    expect(() => assertTestHome(realHome, dirname(realHome))).toThrow(/not a test HOME/);
  });
  it("`..` out of the root is refused, a path under it is accepted", () => {
    expect(() => assertTestHome(join(root, "meute-fleet-home-x", "..", ".."), root)).toThrow(/not a test HOME/);
    expect(() => assertPrivateTestHome(join(tmpdir(), "meute-fleet-home-x", "..", ".."), root)).toThrow();
    expect(assertTestHome(join(root, "home"), root)).toBe(join(root, "home"));
    expect(assertPrivateTestHome(join(tmpdir(), "meute-fleet-home-x"), root)).toBe(join(tmpdir(), "meute-fleet-home-x"));
  });
  it("a symlink out of the root is refused", () => {
    const link = join(tmpdir(), `meute-fleet-home-link-${process.pid}`);
    symlinkSync(dirname(root), link);
    try {
      expect(() => assertPrivateTestHome(link, root)).toThrow();
    } finally {
      unlinkSync(link);
    }
  });
  it("a child HOME must be a meute-fleet-home-* dir in the test TMPDIR", () => {
    expect(() => assertPrivateTestHome(join(root, "home"), root)).toThrow(/private test HOME/);
  });
});

describe("fs-guard refuses changes outside the test root", () => {
  // FLEET_TEST_TMPDIR is the parent of the root: a harmless place outside it.
  const outside = join(dirname(root), `outside-${process.pid}`);
  let release: () => void = () => undefined;
  afterEach(() => {
    release = allowOutsideTestRoot(outside); // the opt-out, used for this exact path only
    rmSync(outside, { recursive: true, force: true });
    release();
  });

  it("chmod, rm, rename and unlink of an outside path throw and change nothing (named imports, sync and promises)", async () => {
    mkdirSync(outside);
    expect(() => chmodSync(outside, 0o777)).toThrow(/fs-guard/);
    await expect(chmod(outside, 0o777)).rejects.toThrow(/fs-guard/);
    expect(() => rmSync(outside, { recursive: true })).toThrow(/fs-guard/);
    await expect(rm(outside, { recursive: true })).rejects.toThrow(/fs-guard/);
    expect(() => renameSync(outside, join(root, "moved"))).toThrow(/fs-guard/);
    expect(() => unlinkSync(join(outside, "nothing"))).toThrow(/fs-guard/);
    expect(() => chmodSync(join(root, "..", `outside-${process.pid}`), 0o777)).toThrow(/fs-guard/);
    const link = join(tmpdir(), `guard-link-${process.pid}`);
    symlinkSync(outside, link);
    try {
      expect(() => chmodSync(link, 0o777)).toThrow(/fs-guard/); // chmod follows the link
    } finally {
      unlinkSync(link); // the link itself is inside the root
    }
    expect(lstatSync(outside).mode & 0o777).not.toBe(0o777);
  });

  it("allowOutsideTestRoot opens one path (and what is under it) until released", () => {
    mkdirSync(outside);
    const done = allowOutsideTestRoot(join(outside, "a"));
    try {
      mkdirSync(join(outside, "a"));
      writeFileSync(join(outside, "a", "x"), "");
      writeFileSync(join(outside, "ab"), "");
      expect(() => unlinkSync(join(outside, "a", "x"))).not.toThrow();
      expect(() => unlinkSync(join(outside, "ab"))).toThrow(/fs-guard/);
    } finally {
      done();
    }
    expect(() => rmSync(join(outside, "a"), { recursive: true })).toThrow(/fs-guard/);
  });
});

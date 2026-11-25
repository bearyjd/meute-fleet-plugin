import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getFinding, health, listFindings, readiness, runStatus } from "../server/fleet";
import { privateHome } from "../server/session";
import { allowOutsideTestRoot, copyRealMeute, hashTree, makeFixtureRoot, realMeuteSource, waitForNoProcessWith, type FixtureRoot } from "./helpers";

// H2: a file of "another run" that the cleanup must leave alone (removed in afterAll, by exact path).
const decoy = join("/tmp", `rr-proof-escape.decoy-${process.pid}`);
beforeAll(() => writeFileSync(decoy, ""));
afterAll(() => {
  const present = existsSync(decoy);
  const release = allowOutsideTestRoot(decoy);
  try {
    rmSync(decoy, { force: true });
  } finally {
    release();
  }
  expect(present).toBe(true);
});

let box: FixtureRoot | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
  // The tmpout stub writes /tmp/rr-proof-escape.$PPID, and its parent is this worker: remove only
  // that file (another run's files are not ours). /tmp is outside the test root: allowed for this path.
  const escaped = join("/tmp", `rr-proof-escape.${process.pid}`);
  const release = allowOutsideTestRoot(escaped);
  try {
    rmSync(escaped, { force: true });
  } finally {
    release();
  }
});

async function exerciseEveryRpc(box: FixtureRoot) {
  const config = box.config;
  const ids = ["sample/audit-2026-11-20#1", "other/audit-2026-11-21#2", "sample/missing#1", "../x#1", "sample/audit-2026-11-20#9"];
  for (let round = 0; round < 2; round++) {
    await listFindings(config);
    for (const id of ids) await getFinding(config, { id });
    for (const name of ["ready", "pending", "invalid"]) {
      await readiness({ ...config, readinessRecordPath: `/records/record-${name}.json` });
    }
    await readiness({ ...config, readinessRecordPath: undefined });
    await health(config);
    await runStatus(config, { lines: 20 });
    await Promise.all([listFindings(config), health(config), runStatus(config, { lines: 1 })]);
  }
}

// Writes outside the box (re-review 07 files R1): top-level entries ADDED to the temp dirs since
// the test began (the harness's own fleet-* sandboxes and the runner's private HOMEs excluded;
// other processes share /tmp, so removals and deep writes into existing entries are not
// judged), and this worker's private HOME if it is no longer empty.
const TEMP_DIRS = [...new Set([tmpdir(), "/tmp"])];
const HARNESS = /^(fleet-|meute-fleet-home-|rr-proof-escape\.decoy-)/;
const tempEntries = () =>
  TEMP_DIRS.flatMap((dir) => readdirSync(dir).filter((name) => !HARNESS.test(name)).map((name) => join(dir, name)));
let tempAtStart = new Set<string>();
let home = "";
beforeEach(async () => {
  tempAtStart = new Set(tempEntries());
  home = (await privateHome()) ?? "";
  expect(home).not.toBe("");
});
// Other programs on the host make short-lived files in /tmp (seen under CPU load: Rust's
// `.tmpXXXXXX`): an added entry counts only if it is still there a second later. A write by the
// stub or by meute is not removed, so it still shows.
const addedTempEntries = () => {
  const added = tempEntries().filter((path) => !tempAtStart.has(path));
  if (added.length === 0) return added;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
  return added.filter((path) => existsSync(path)).sort();
};
// A HOME the child wrote into is replaced and removed by the next call: gone counts as changed.
const outside = () => JSON.stringify([addedTempEntries(), existsSync(home) ? readdirSync(home) : ["<private HOME removed>"]]);

/** The root and everything beside it (parent dir, sibling dir), minus the stub's ctl/ channel, plus the temp dirs. */
const snapshot = (b: FixtureRoot) => `${hashTree(b.dir, ["/ctl"])}\n${outside()}`;

/** RPCs, then wait until no process carrying this MEUTE_ROOT is left (late writers included). */
async function exerciseAndSettle(b: FixtureRoot) {
  await exerciseEveryRpc(b);
  await waitForNoProcessWith(`MEUTE_ROOT=${b.root}`, 10_000);
}

describe("read-only proof: the root and its surroundings are identical after every RPC", () => {
  it.each(["normal", "unhealthy"])("stub mode %s", async (mode) => {
    box = makeFixtureRoot();
    box.setMode(mode);
    const before = snapshot(box);
    await exerciseAndSettle(box);
    expect(box.calls().length).toBeGreaterThan(5); // the stub really ran
    expect(snapshot(box)).toBe(before);
  });

  // The proof must be able to fail: each deliberately misbehaving stub is caught.
  it.each([
    ["write", "appends to state/log"],
    ["tmpwrite", "creates and deletes a temp file (only the directory mtime shows it)"],
    ["pycache", "creates a directory"],
    ["xattr", "sets an extended attribute (only ctime shows it)"],
    ["chmod", "changes the mode and changes it back"],
    ["restore", "rewrites content, then restores content and mtime"],
    ["outside", "writes beside MEUTE_ROOT"],
    ["sibling", "writes into a sibling directory"],
    ["late", "leaves a setsid child that writes 1 s after the call returned"],
    ["tmpout", "writes a new file into /tmp"],
    ["homewrite", "writes into its (private) HOME"],
  ])("detects a stub that writes (%s: %s)", async (mode) => {
    box = makeFixtureRoot();
    box.setMode(mode);
    const before = snapshot(box);
    await exerciseAndSettle(box);
    expect(snapshot(box)).not.toBe(before);
  });

  it("detects a changed mtime with identical content", () => {
    box = makeFixtureRoot();
    const before = hashTree(box.root);
    utimesSync(join(box.root, "state/log"), new Date(), new Date(1_700_000_000_000));
    expect(hashTree(box.root)).not.toBe(before);
  });
});

// The real meute from a checkout, copied (never symlinked, so no __pycache__ lands there).
// MEUTE_SOURCE_DIR has no default: unset is a counted, named skip; set but unusable fails.
const real = realMeuteSource();

describe.skipIf("skip" in real)(`read-only proof against the real meute CLI (copied checkout) ${"skip" in real ? `[SKIPPED: ${real.skip}]` : ""}`, () => {
  it("findings, health and run status leave the tree identical", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-real-")));
    try {
      const root = join(dir, "root");
      const config = { ...copyRealMeute((real as { source: string }).source, root), timeoutMs: 20_000 };
      mkdirSync(join(dir, "x"));
      const before = `${hashTree(dir)}\n${outside()}`; // the root, its parent, a sibling dir, the temp dirs
      const findings = await listFindings(config);
      const healthResult = await health(config);
      const status = await runStatus(config, { lines: 5 });
      const detail = await getFinding(config, { id: "sample/audit-2026-11-20#1" });
      expect(findings).toMatchObject({ ok: true });
      expect(healthResult.ok).toBe(true);
      expect(status.ok && detail.ok).toBe(true);
      await waitForNoProcessWith(`MEUTE_ROOT=${root}`, 10_000);
      expect(`${hashTree(dir)}\n${outside()}`).toBe(before);
      writeFileSync(join(dir, "marker"), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

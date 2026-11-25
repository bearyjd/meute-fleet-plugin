// The whole Meute code tree is guarded, not only bin/meute (re-review 07: runner N2, tests B1):
// bin/meute sources lib/*.sh and runs python3 on lib/*.py, so whoever can write any of it runs
// code as the daemon user. Exempt: state/, reports/, .worktrees/ (data meute writes) and
// .git/objects, refs, logs (git data, never executed by the three allowlisted commands).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkExecutable } from "../server/config";
import { checkCodeTree } from "../server/tree";
import { runAllowlisted } from "../server/runner";
import { copyRealMeute, makeSandbox, realMeuteSource, type Sandbox } from "./helpers";

let box: Sandbox | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
});

const uid = process.getuid?.() ?? 0;

/** A sandbox shaped like meute: bin/meute sources lib/health.sh, plus bin/run.sh, tasks/, repos.yaml. */
function meuteLike(): Sandbox {
  const b = makeSandbox('source "$MEUTE_ROOT/lib/health.sh"; echo "ran=${INJECTED:-no}"');
  mkdirSync(join(b.root, "lib", "deep", "er"), { recursive: true });
  writeFileSync(join(b.root, "lib", "health.sh"), "cmd_health() { :; }\n");
  writeFileSync(join(b.root, "lib", "deep", "er", "x.py"), "pass\n");
  writeFileSync(join(b.root, "bin", "run.sh"), "#!/bin/bash\n");
  chmodSync(join(b.root, "bin", "run.sh"), 0o755);
  mkdirSync(join(b.root, "tasks"));
  writeFileSync(join(b.root, "tasks", "scout.md"), "task\n");
  writeFileSync(join(b.root, "repos.yaml"), "repos: []\n");
  mkdirSync(join(b.root, ".worktrees"));
  return b;
}

async function expectTreeRefused(b: Sandbox, reason: RegExp) {
  const run = await runAllowlisted(b.config, "health");
  expect(run).toMatchObject({ ok: false, code: "invalid_config" });
  expect(!run.ok && run.message).toMatch(reason);
  // The entry is named relative to MEUTE_ROOT (L3), never by a host path.
  expect(!run.ok && run.message).not.toContain(b.dir);
  expect(!run.ok && run.message).not.toMatch(/(^|\s)\//);
}

describe("every entry of the code tree is checked before each spawn", () => {
  it("control: the meute-shaped tree passes and lib/health.sh is really sourced", async () => {
    box = meuteLike();
    expect(await checkExecutable(box.config)).toEqual({ ok: true });
    const run = await runAllowlisted(box.config, "health");
    expect(run).toMatchObject({ ok: true, stdout: "ran=no\n" });
  });

  it.each([
    ["lib/health.sh 0666", "lib/health.sh", 0o666],
    ["bin/run.sh 0777", "bin/run.sh", 0o777],
    ["tasks/ 0777", "tasks", 0o777],
    ["repos.yaml 0666", "repos.yaml", 0o666],
    ["lib/deep/er/ 0775 (a writable dir deep inside lib/)", "lib/deep/er", 0o775],
    ["lib/ sticky 1777 (sticky is no exemption inside the tree)", "lib", 0o1777],
  ])("refuses %s, and the injected code does not run", async (_label, rel, mode) => {
    box = meuteLike();
    writeFileSync(join(box.root, "lib", "health.sh"), "INJECTED=yes\n");
    chmodSync(join(box.root, rel), mode);
    await expectTreeRefused(box, new RegExp(`^Unsafe configuration: an entry of the Meute code tree is writable by group or others: ${rel}$`));
  });

  it("refuses a symlink anywhere in lib/ (inside or outside the tree)", async () => {
    box = meuteLike();
    symlinkSync("/etc/passwd", join(box.root, "lib", "out.sh"));
    await expectTreeRefused(box, /code tree contains a symbolic link/);
    rmSync(join(box.root, "lib", "out.sh"));
    symlinkSync("health.sh", join(box.root, "lib", "deep", "in.sh"));
    await expectTreeRefused(box, /code tree contains a symbolic link/);
  });

  it("refuses a FIFO (only regular files and directories)", async () => {
    box = meuteLike();
    execFileSync("mkfifo", [join(box.root, "lib", "pipe")]);
    await expectTreeRefused(box, /code tree contains a special file/);
  });

  it("walks lib/__pycache__ (python reads .pyc even with PYTHONDONTWRITEBYTECODE)", async () => {
    box = meuteLike();
    mkdirSync(join(box.root, "lib", "__pycache__"));
    writeFileSync(join(box.root, "lib", "__pycache__", "health.cpython-313.pyc"), "");
    chmodSync(join(box.root, "lib", "__pycache__", "health.cpython-313.pyc"), 0o666);
    await expectTreeRefused(box, /writable by group or others/);
  });

  it("walks .git except its object/ref/log data", async () => {
    box = meuteLike();
    for (const dir of [".git/hooks", ".git/objects/ab", ".git/refs/heads", ".git/logs"]) mkdirSync(join(box.root, dir), { recursive: true });
    for (const data of [".git/objects/ab", ".git/refs/heads", ".git/logs"]) chmodSync(join(box.root, data), 0o777);
    expect(await checkExecutable(box.config)).toEqual({ ok: true });
    writeFileSync(join(box.root, ".git", "config"), "[core]\n");
    chmodSync(join(box.root, ".git", "config"), 0o666);
    expect(await checkExecutable(box.config)).toMatchObject({ ok: false, message: expect.stringMatching(/writable by group/) });
  });

  it("does not walk state/, reports/ or .worktrees/ (meute's data)", async () => {
    box = meuteLike();
    for (const dir of ["state", "reports", ".worktrees"]) {
      chmodSync(join(box.root, dir), 0o777);
      symlinkSync("/etc", join(box.root, dir, "link"));
    }
    expect(await checkExecutable(box.config)).toEqual({ ok: true });
  });

  it("but only at the top: a lib/state directory is walked", async () => {
    box = meuteLike();
    mkdirSync(join(box.root, "lib", "state"));
    chmodSync(join(box.root, "lib", "state"), 0o777);
    expect(await checkExecutable(box.config)).toMatchObject({ ok: false });
  });

  it("re-walks after any change: a deep chmod after a good call is refused next call", async () => {
    box = meuteLike();
    expect((await runAllowlisted(box.config, "health")).ok).toBe(true);
    expect((await runAllowlisted(box.config, "health")).ok).toBe(true);
    chmodSync(join(box.root, "lib", "deep", "er", "x.py"), 0o646); // no directory mtime/ctime changes
    await expectTreeRefused(box, /writable by group or others/);
    chmodSync(join(box.root, "lib", "deep", "er", "x.py"), 0o644);
    writeFileSync(join(box.root, "lib", "deep", "er", "new.sh"), "");
    chmodSync(join(box.root, "lib", "deep", "er", "new.sh"), 0o666); // a new entry in a cached directory
    await expectTreeRefused(box, /writable by group or others/);
  });

  it("fails closed over the entry cap", async () => {
    box = meuteLike();
    for (let i = 0; i < 20; i++) writeFileSync(join(box.root, "lib", `f${i}`), "");
    expect(await checkCodeTree(box.root, uid, 100)).toEqual({ ok: true });
    expect(await checkCodeTree(box.root, uid, 20)).toEqual({
      ok: false,
      message: "Unsafe configuration: the Meute code tree has more than 20 entries",
    });
  });

  it("the spawn is refused, not only the check: no child runs", async () => {
    box = meuteLike();
    chmodSync(join(box.root, "repos.yaml"), 0o666);
    await expectTreeRefused(box, /writable/);
    expect(existsSync(box.argsFile)).toBe(false);
  });
});

describe("re-review 08: the root, the named entry, the .git skip and the listing cache", () => {
  it.each([["sticky 1777", 0o1777], ["sticky 1775", 0o1775], ["0777", 0o777], ["0775", 0o775]])(
    "M2: MEUTE_ROOT itself %s is refused (sticky is no exemption for the root)", async (_label, mode) => {
      box = meuteLike();
      chmodSync(box.root, mode);
      await expectTreeRefused(box, /^Unsafe configuration: MEUTE_ROOT itself is writable by group or others$/);
    });

  it("L3: a refusal names the entry relative to MEUTE_ROOT, sanitized", async () => {
    box = meuteLike();
    const name = "evil\u202e\u001b[31mname.sh";
    writeFileSync(join(box.root, "lib", "deep", name), "");
    chmodSync(join(box.root, "lib", "deep", name), 0o666);
    await expectTreeRefused(box, /: lib\/deep\/evilname\.sh$/); // bidi override and ANSI escape stripped
  });

  it.each(["lib/logs/x.sh", "lib/refs/x.sh", "lib/objects/x.sh", "lib/sub/.git/logs/x"])(
    "T1: %s 0666 is refused (only the root's .git/{objects,refs,logs} are skipped)", async (rel) => {
      box = meuteLike();
      mkdirSync(join(box.root, dirname(rel)), { recursive: true });
      writeFileSync(join(box.root, rel), "");
      chmodSync(join(box.root, rel), 0o666);
      await expectTreeRefused(box, new RegExp(`writable by group or others: ${rel}$`));
    });

  it("T1 control: the root's .git/logs, .git/refs and .git/objects are skipped", async () => {
    box = meuteLike();
    for (const dir of ["logs", "refs", "objects"]) {
      mkdirSync(join(box.root, ".git", dir), { recursive: true });
      writeFileSync(join(box.root, ".git", dir, "x"), "");
      chmodSync(join(box.root, ".git", dir, "x"), 0o666);
    }
    expect(await checkExecutable(box.config)).toEqual({ ok: true });
  });

  it("T2: .git/hooks is walked: a 0777 hook is refused", async () => {
    box = meuteLike();
    mkdirSync(join(box.root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(box.root, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
    chmodSync(join(box.root, ".git", "hooks", "pre-commit"), 0o755);
    expect(await checkExecutable(box.config)).toEqual({ ok: true });
    chmodSync(join(box.root, ".git", "hooks", "pre-commit"), 0o777);
    await expectTreeRefused(box, /writable by group or others: \.git\/hooks\/pre-commit$/);
  });

  it("T3: a same-length rename in a cached directory (size unchanged, only mtime/ctime move) is seen", async () => {
    box = meuteLike();
    const dir = join(box.root, "lib", "deep", "er");
    writeFileSync(join(dir, "a.sh"), "");
    expect(await checkCodeTree(box.root, uid)).toEqual({ ok: true }); // the listing is now cached
    const size = statSync(dir).size;
    rmSync(join(dir, "a.sh"));
    writeFileSync(join(dir, "b.sh"), "");
    chmodSync(join(dir, "b.sh"), 0o666);
    expect(statSync(dir).size).toBe(size);
    expect(await checkCodeTree(box.root, uid)).toEqual({
      ok: false,
      message: "Unsafe configuration: an entry of the Meute code tree is writable by group or others: lib/deep/er/b.sh",
    });
  });
});

const real = realMeuteSource();

describe.skipIf("skip" in real)(`tree walk on a copy of the real meute ${"skip" in real ? `[SKIPPED: ${real.skip}]` : ""}`, () => {
  it("passes and stays fast (cold and warm)", async () => {
    box = makeSandbox("true");
    rmSync(box.root, { recursive: true });
    const config = copyRealMeute((real as { source: string }).source, box.root);
    const cold0 = performance.now();
    expect(await checkCodeTree(config.meuteRoot, uid)).toEqual({ ok: true });
    const cold = performance.now() - cold0;
    const warm0 = performance.now();
    for (let i = 0; i < 20; i++) await checkCodeTree(config.meuteRoot, uid);
    const warm = (performance.now() - warm0) / 20;
    console.error(`TREEWALK real meute copy: cold ${cold.toFixed(1)} ms, warm ${warm.toFixed(1)} ms per walk`);
    expect(warm).toBeLessThan(250);
    chmodSync(join(config.meuteRoot, "lib", "health.sh"), 0o666);
    expect(await checkCodeTree(config.meuteRoot, uid)).toMatchObject({ ok: false });
  });
});

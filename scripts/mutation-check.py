#!/usr/bin/env python3
"""Mutation check of the safety-critical code, in a throwaway copy (the repo is never modified).

Each mutant must make the FULL suite (`vitest run`, every test file) fail. Set MEUTE_SOURCE_DIR to
include the real-meute tests. Usage: python3 scripts/mutation-check.py [--list] [--only <substring>]
Per-mutant dirs live under $FLEET_TEST_TMPDIR (default <repo>/.test-tmp), never under the real HOME.
"""
import os, shutil, subprocess, sys, tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (name, file, old, new)
MUTANTS = [
    # --- runner: allowlist, argv, env
    ("drop allowlist check", "server/runner.ts", 'if (typeof id !== "string" || !Object.hasOwn(ALLOWLIST, id)) {', "if (false) {"),
    ("allowlist via `in` (prototype keys pass)", "server/runner.ts", '!Object.hasOwn(ALLOWLIST, id)', '!(id in ALLOWLIST)'),
    ("allow shell", "server/runner.ts", "shell: false,", "shell: true,"),
    ("inherit daemon env", "server/runner.ts", "        env,\n", "        env: { ...process.env, ...env },\n"),
    ("leak SSH_AUTH_SOCK via process['env']", "server/runner.ts", "        env,\n",
     '        env: { ...env, SSH_AUTH_SOCK: String(process["env"]["SSH_AUTH_SOCK"]) },\n'),
    ("path params unvalidated", "server/runner.ts", "if (!isSafeAbsolutePath(value)) return fail", "if (typeof value !== 'string') return fail"),
    ("accept any exit code", "server/runner.ts", "!spec.okExitCodes.includes(exitCode)", "false"),
    ("run in the daemon cwd", "server/runner.ts", "cwd: config.meuteRoot,", ""),
    ("skip meutePath == <root>/bin/meute", "server/config.ts", '!isSafeAbsolutePath(config.meuteRoot) || config.meutePath !== join(config.meuteRoot, "bin", "meute")', "false"),
    ("allow extra params", "server/runner.ts", "if (!keys.every((key) => spec.slots.includes(key))) {", "if (false) {"),
    ("negative timeout not clamped", "server/runner.ts", "if (!Number.isSafeInteger(requested) || requested < 1)", "if (!Number.isSafeInteger(requested))"),
    ("default output cap x100", "server/runner.ts", "DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;", "DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024 * 1024;"),
    # --- runner: timeout, settle, kill, dedup, concurrency
    ("no SIGTERM at the deadline", "server/runner.ts", "    later(timeoutMs, () => {", "    later(1e9, () => {"),
    ("drop size cap", "server/runner.ts", "if (chunk.length > room) {", "if (false) {"),
    ("kill only the leader, not the group", "server/runner.ts", "process.kill(-pid, signal);", "process.kill(pid, signal);"),
    ("NEW settle-on-timer removed", "server/runner.ts", "later(timeoutMs + graceMs + SETTLE_MARGIN_MS, () => finish(timeout()));", ""),
    ("NEW exit drain removed", "server/runner.ts", "      later(DRAIN_MS, () =>", "      if (false) later(DRAIN_MS, () =>"),
    ("NEW in-flight entry never cleared", "server/runner.ts", "})().finally(() => inflight.delete(key));", "})().finally(() => undefined);"),
    ("NEW bare-pid kill after exit (pid reuse)", "server/runner.ts", "    if (leaderExited) return;\n", ""),
    ("NEW env not in the dedup key", "server/runner.ts", 'JSON.stringify([config.meutePath, argv, config.runnerPath ?? "", config.xdgRuntimeDir ?? "", effectiveTimeoutMs(config)])', "JSON.stringify([config.meutePath, argv])"),
    ("NEW no concurrency bound", "server/runner.ts", "if (running >= MAX_CONCURRENT) {", "if (false) {"),
    # --- config: per-call executable validation
    ("NEW no per-call validation before spawn", "server/runner.ts", '    if (!safety.ok) return fail("invalid_config", safety.message);\n', ""),
    ("NEW symlinked component allowed", "server/config.ts", "if ((await realpath(config.meutePath)) !== config.meutePath) {", "if (false) {"),
    ("NEW group/other-writable binary allowed", "server/config.ts", 'if ((binary.mode & WRITABLE_BY_OTHERS) !== 0) return unsafe("the Meute binary is writable', 'if (false) return unsafe("the Meute binary is writable'),
    ("NEW binary owner not checked", "server/config.ts", "if (binary.uid !== uid && binary.uid !== 0) return", "if (false) return"),
    ("NEW writable ancestor allowed", "server/config.ts", "if (!sticky && (info.mode & WRITABLE_BY_OTHERS) !== 0) {", "if (false) {"),
    ("NEW sticky exemption for every ancestor bit", "server/config.ts", "const sticky = (info.mode & STICKY) !== 0;", "const sticky = true;"),
    ("NEW writable PATH dir allowed", "server/config.ts", 'if ((info.mode & WRITABLE_BY_OTHERS) !== 0) return unsafe("a PATH directory is writable', 'if (false) return unsafe("a PATH directory is writable'),
    ("R2 sticky exempts the ancestor owner check (N1)", "server/config.ts", "    if (info.uid !== uid && info.uid !== 0) {", "    if (!sticky && info.uid !== uid && info.uid !== 0) {"),
    ("R2 ancestor owner not checked (RR04)", "server/config.ts", "    if (info.uid !== uid && info.uid !== 0) {", "    if (false) {"),
    ("R2 PATH dir owner not checked (RR05)", "server/config.ts", 'if (info.uid !== uid && info.uid !== 0) return unsafe("a PATH directory is owned', 'if (false) return unsafe("a PATH directory is owned'),
    ("R2 PATH dir parents not checked (RR06)", "server/config.ts", "if (!parents.ok) return unsafe(", "if (false) return unsafe("),
    ("R2 no code-tree walk (N2)", "server/config.ts", "    if (!tree.ok) return tree;\n", ""),
    ("R2 tree walk skips lib/", "server/tree.ts", 'new Set(["state", "reports", ".worktrees"])', 'new Set(["state", "reports", ".worktrees", "lib"])'),
    ("R2 tree walk skips tasks/", "server/tree.ts", 'new Set(["state", "reports", ".worktrees"])', 'new Set(["state", "reports", ".worktrees", "tasks"])'),
    ("R2 tree walk skips repos.yaml", "server/tree.ts", 'new Set(["state", "reports", ".worktrees"])', 'new Set(["state", "reports", ".worktrees", "repos.yaml"])'),
    ("R2 tree walk skips bin/ siblings", "server/tree.ts", 'new Set(["state", "reports", ".worktrees"])', 'new Set(["state", "reports", ".worktrees", "bin"])'),
    ("R2 tree walk skips __pycache__", "server/tree.ts", '!(next.rel === "" && SKIP_AT_TOP.has(name))', '!(next.rel === "" && SKIP_AT_TOP.has(name)) && name !== "__pycache__"'),
    ("R2 tree walk skips all of .git", "server/tree.ts", '!(next.rel === ".git" && SKIP_IN_GIT.has(name))', 'name !== ".git"'),
    ("R2 tree skip applies at every depth", "server/tree.ts", '!(next.rel === "" && SKIP_AT_TOP.has(name))', "!SKIP_AT_TOP.has(name)"),
    ("R2 tree allows symlinks", "server/tree.ts", 'if (info.isSymbolicLink()) return named(', "if (false) return named("),
    ("R2 tree allows special files", "server/tree.ts", 'if (!info.isFile() && !info.isDirectory()) return named(', "if (false) return named("),
    ("R2 tree owner not checked", "server/tree.ts", "if (info.uid !== owner && info.uid !== 0n) return", "if (false) return"),
    ("R2 tree mode not checked", "server/tree.ts", "if ((info.mode & WRITABLE_BY_OTHERS) !== 0n) return", "if (false) return"),
    ("R2 tree trusts cached directories (no re-walk)", "server/tree.ts", "if (cached && cached.stamp === stamp) return cached.names;", "if (cached && cached.stamp === stamp) return [];"),
    ("R2 tree cache ignores the directory stamp", "server/tree.ts", "if (cached && cached.stamp === stamp) return cached.names;", "if (cached) return cached.names;"),
    ("R2 tree entry cap off", "server/tree.ts", "if (seen > cap) return unsafe(", "if (false) return unsafe("),
    ("M2 MEUTE_ROOT mode not checked", "server/tree.ts", '  if ((top.mode & WRITABLE_BY_OTHERS) !== 0n) return unsafe("MEUTE_ROOT itself', '  if (false) return unsafe("MEUTE_ROOT itself'),
    ("M2 MEUTE_ROOT keeps the sticky exemption", "server/tree.ts", "  if ((top.mode & WRITABLE_BY_OTHERS) !== 0n) return", "  if ((top.mode & WRITABLE_BY_OTHERS) !== 0n && (top.mode & 0o1000n) === 0n) return"),
    ("M2 MEUTE_ROOT owner not checked", "server/tree.ts", '  if (top.uid !== owner && top.uid !== 0n) return unsafe(', '  if (false) return unsafe('),
    ("L3 refusal does not name the entry", "server/tree.ts", "unsafe(`${reason}: ${sanitizeText(rel, 200).replace(/\\s+/g, \" \")}`)", "unsafe(reason)"),
    ("L3 entry name not sanitized", "server/tree.ts", "${sanitizeText(rel, 200).replace(", "${(rel).replace("),
    ("L2 root-owned binary refused", "server/config.ts", "if (binary.uid !== uid && binary.uid !== 0) return", "if (binary.uid !== uid) return"),
    ("T1 .git skip applies at every depth", "server/tree.ts", '!(next.rel === ".git" && SKIP_IN_GIT.has(name))', "!SKIP_IN_GIT.has(name)"),
    ("T2 .git/hooks skipped", "server/tree.ts", 'new Set(["objects", "refs", "logs"])', 'new Set(["objects", "refs", "logs", "hooks"])'),
    ("T3 listing stamp without mtime/ctime", "server/tree.ts", "`${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`", "`${info.ino}:${info.size}`"),
    ("R2 HOME from the daemon environment (N4)", "server/runner.ts", "    HOME: home,\n", '    HOME: process.env["HOME"] ?? home,\n'),
    ("R2 private HOME not re-verified", "server/session.ts", "if (previous !== null && (await isPrivateEmptyDir(previous, uid))) return previous;", "if (previous !== null) return previous;"),
    ("R2 private HOME may be non-empty", "server/session.ts", "    if ((await readdir(dir)).length !== 0) return false;\n", ""),
    ("R2 private HOME mode not checked", "server/session.ts", "|| (info.mode & 0o7777) !== 0o700) return false;", ") return false;"),
    ("M1 refused HOME not removed", "server/session.ts", "    await rmdir(created).catch(() => undefined); // M1", "    // M1"),
    ("M1 replaced HOME not removed", "server/session.ts", "  if (previous !== null) await discard(previous, uid);\n", ""),
    ("M1 replaced HOME removed recursively even when not private", "server/session.ts", "if ((info.mode & 0o7777) === 0o700) await rm(", "if (true) await rm("),
    ("M1 no exit cleanup", "server/session.ts", 'process.on("exit", removePrivateHomes);', "undefined;"),
    ("S1 private HOME ancestors unchecked", "server/session.ts", "    return (await checkAncestors(dirname(dir), uid)).ok;\n", "    return true;\n"),
    ("S2 private HOME owner unchecked", "server/session.ts", "if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o7777) !== 0o700) return false;", "if (!info.isDirectory() || (info.mode & 0o7777) !== 0o700) return false;"),
    ("R2 no PYTHONNOUSERSITE", "server/runner.ts", '    PYTHONNOUSERSITE: "1",\n', ""),
    ("R2 no GIT_CONFIG_GLOBAL", "server/runner.ts", '    GIT_CONFIG_GLOBAL: "/dev/null",\n', ""),
    ("R2 no GIT_CONFIG_NOSYSTEM", "server/runner.ts", '    GIT_CONFIG_NOSYSTEM: "1",\n', ""),
    ("R2 XDG_CONFIG_HOME not in the private HOME", "server/runner.ts", '    XDG_CONFIG_HOME: join(home, ".config"),\n', ""),
    ("NEW symlinked PATH dir allowed", "server/config.ts", 'if ((await realpath(dir)) !== dir) return unsafe', 'if (false) return unsafe'),
    # --- health positive signal
    ("NEW health ignores the bus check", "server/fleet.ts", 'result.data.state === "healthy" && !outcome.runtime.ok', 'result.data.state === "healthy" && false'),
    ("M3 probe-only health (its own bus probe, not the runner's report)", "server/fleet.ts",
     '  if (result.ok && result.data.state === "healthy" && !outcome.runtime.ok) {\n    return success({ state: "unknown", problems: [outcome.runtime.message] });',
     '  const bus = await (await import("./session")).checkRuntimeDir(config.xdgRuntimeDir);\n  if (result.ok && result.data.state === "healthy" && !bus.ok) {\n    return success({ state: "unknown", problems: [bus.message] });'),
    ("M3 runner reports the probe, not what it passed", "server/runner.ts", "  const passed = env[\"XDG_RUNTIME_DIR\"] !== undefined;\n", "  const passed = probe.ok;\n"),
    # "bus need not be a socket" is equivalent since round 2: connect() to a non-socket always fails.
    ("NEW runtime dir need not be private", "server/session.ts", "|| (runtime.mode & 0o077) !== 0) {", ") {"),
    ("R2 dead-socket probe off (N3)", "server/session.ts", 'if (!(await connects(join(dir, "bus")))) return reason(', "if (false) return reason("),
    ("R2 XDG_RUNTIME_DIR passed unchecked", "server/runner.ts", "const env = buildEnv(config, home, probe.ok ? config.xdgRuntimeDir : undefined);", "const env = buildEnv(config, home, config.xdgRuntimeDir);"),
    ("health: whitespace output still healthy", "server/parsers.ts", 'if (stdout !== "" || stderr !== "") {', 'if (stderr.trim() !== "") {'),
    # --- safefs
    ("NEW no O_NOFOLLOW on directories", "server/safefs.ts", "constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;", "constants.O_RDONLY | constants.O_DIRECTORY;"),
    ("no O_NOFOLLOW on the file", "server/safefs.ts", "constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;", "constants.O_RDONLY | constants.O_NONBLOCK;"),
    ("NEW skip the /proc/self/fd path verification", "server/safefs.ts", "if (actual !== join(rootReal, ...segments)) {", "if (false) {"),
    ("NEW walk from the joined path (no openat)", "server/safefs.ts", "const handle = await open(viaFd(dir, segments[segments.length - 1]), FILE_FLAGS);",
     "const handle = await open(join(rootReal, ...segments), constants.O_RDONLY | constants.O_NONBLOCK);"),
    ("skip S_ISREG (regular-file check)", "server/safefs.ts", "if (!info.isFile() || info.nlink !== 1) {", "if (info.nlink !== 1) {"),
    ("skip hard-link check", "server/safefs.ts", "if (!info.isFile() || info.nlink !== 1) {", "if (!info.isFile()) {"),
    ("accept '..' in names", "shared/validate.ts", 'NAME_RE.test(value) && !value.includes("..")', "NAME_RE.test(value)"),
    ("log tail reads whole file", "server/safefs.ts", "const length = tailBytes === undefined ? info.size : Math.min(info.size, tailBytes);", "const length = info.size;"),
    ("report size cap off", "server/safefs.ts", "if (tailBytes === undefined && info.size > maxBytes)", "if (false)"),
    ("tail cap x100", "server/safefs.ts", "MAX_TAIL_BYTES = 256 * 1024;", "MAX_TAIL_BYTES = 25600 * 1024;"),
    ("tail keeps the half-cut first line", "server/safefs.ts", "  if (partial) {\n    const cut", "  if (false) {\n    const cut"),
    ("NEW tail window without the extra byte", "server/safefs.ts", 'readRegular(root, ["state", "log"], Infinity, tailBytes + 1)', 'readRegular(root, ["state", "log"], Infinity, tailBytes)'),
    ("NEW invalid UTF-8 replaced, not refused", "server/safefs.ts", 'new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })', 'new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })'),
    ("NEW BOM stripped (numbering diverges)", "server/safefs.ts", 'new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })', 'new TextDecoder("utf-8", { fatal: true })'),
    # --- numbering (differential)
    ("NEW JS ^ semantics (m flag)", "server/parsers.ts", 'const LINE_START = "(?<![^\\\\n])";', 'const LINE_START = "(?<![^\\\\n\\\\u2028\\\\u2029])";'),
    ("NEW whitespace class without NBSP", "server/parsers.ts", "\\\\x85\\\\xa0\\\\u1680", "\\\\x85\\\\u1680"),
    ("NEW title uses JS trim", "server/parsers.ts", 'title: sanitizeText(pyStrip(head[2] ?? ""), 300),', 'title: sanitizeText((head[2] ?? "").trim(), 300),'),
    # --- parsers, redaction
    ("readiness: ignore exit/status disagreement", "server/parsers.ts", "raw.status !== verdict", "false"),
    ("readiness: ready with failed check", "server/parsers.ts", 'verdict === "ready" && !raw.checks.every', 'false && !raw.checks.every'),
    ("NEW readiness parser: ready with zero checks", "server/parsers.ts", 'if (verdict === "ready" && raw.checks.length === 0) {', "if (false) {"),
    ("findings cap removed", "server/parsers.ts", ".max(MAX_FINDINGS)", ""),
    ("readiness checks cap removed", "server/parsers.ts", "{ check: z.string(), status: z.string(), reason: z.string() }).loose()).max(200)", "{ check: z.string(), status: z.string(), reason: z.string() }).loose())"),
    ("no path redaction", "shared/validate.ts", '/g, "<path>");\n}', '/g, "$&");\n}'),
    ("lock startedAt not redacted", "server/parsers.ts", 'startedAt: redactPaths(clean(fields["started"] ?? "", 64)),', 'startedAt: clean(fields["started"] ?? "", 64),'),
    ("lock key not redacted", "server/parsers.ts", 'key: redactPaths(clean(fields["key"] ?? "", 200)),', 'key: clean(fields["key"] ?? "", 200),'),
    ("log fields not redacted", "server/parsers.ts", "fields[key] = redactPaths(clean(part.slice(at + 1), 200));", "fields[key] = clean(part.slice(at + 1), 200);"),
    ("configured paths not passed for redaction", "server/fleet.ts", "parseReadiness(outcome.exitCode, outcome.stdout, knownPaths(config))", "parseReadiness(outcome.exitCode, outcome.stdout, config.meuteRoot)"),
    ("lock read error shown as no lock", "server/fleet.ts", '    : lockFile.code === "not_found"', '    : true'),
    ("log read error shown as empty log", "server/fleet.ts", '    : logTail.code === "not_found"', '    : true'),
    ("NAME_RE allows + and ~", "shared/validate.ts", "/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/", "/^[A-Za-z0-9][A-Za-z0-9._+~-]{0,127}$/"),
    ("sanitize keeps bidi isolates", "shared/validate.ts", "\\u202a-\\u202e\\u2066-\\u2069\\ufeff]/g", "\\u202a-\\u202e\\ufeff]/g"),
    # --- client view model, hook, settings
    ("NEW no stale-by-age", "client/viewmodel.ts", "const aged = baseMs !== null &&", "const aged = false && baseMs !== null &&"),
    ("NEW resume not marked stale", "client/viewmodel.ts", "if (aged || state.resumed === true) {", "if (aged) {"),
    ("NEW stale READY keeps the success colour", "client/viewmodel.ts", 'if (fresh.stale && view.tone === "success") {', "if (false) {"),
    ("NEW readiness view: ready with zero checks", "client/viewmodel.ts", 'if (data.verdict === "ready" && rows.length === 0) {', "if (false) {"),
    ("readiness view ignores exit code", "client/viewmodel.ts", 'data.exitCode === 0 && outstanding.length === 0', 'outstanding.length === 0'),
    ("stale drop 5 -> 50 min", "client/viewmodel.ts", "STALE_DROP_MS = 5 * 60 * 1000;", "STALE_DROP_MS = 50 * 60 * 1000;"),
    ("NEW refresh in flight starts a second loop", "client/use-polled.ts", "      if (inFlight) {\n        rerun = true;\n        return;\n      }\n", ""),
    ("NEW no stale tick while a call hangs", "client/use-polled.ts", "Math.max(0, due)", "1e9"),
    ("NEW dead loop runs on background refresh", "client/use-polled.ts", "      refreshRef.current = noop; // a refresh", "      // a refresh"),
    ("NEW loading stuck after cancel", "client/use-polled.ts", "      setLoading(false);\n    };\n  }, [foreground", "    };\n  }, [foreground"),
    ("NEW no resume marking in the hook", "client/use-polled.ts", "setState((previous) => markResumed(previous));", ""),
    ("NEW settings save with the live revision", "client/settings-screen.tsx", "await save(sending, baseRevision)", "await save(sending, revision)"),
    ("R2 no-op save stays armed and adopts any revision (N8)", "client/settings-screen.tsx",
     "  if (saved.current !== null && (revision !== baseRevision || sameValues(values, saved.current))) {\n    if (sameValues(values, saved.current)) {",
     "  if (saved.current !== null && revision !== baseRevision) {\n    if (true) {"),
    ("R2 inbox row hides state from screen readers (N12)", "client/inbox.tsx", ": ${finding.title}, ${finding.state}", ": ${finding.title}"),
    ("C1 banner without a live region", "client/common.tsx", ' accessibilityLiveRegion="polite"', ""),
    ("U6 stale rows not dimmed", "client/inbox.tsx", "opacity: stale ? 0.5 : 1", "opacity: 1"),
    ("NEW no Reset for invalid settings", "client/settings-screen.tsx", 'settings.status === "invalid" ? (', "false ? ("),
    ("NEW stale run lock keeps its colour", "client/run.tsx", 'const tone = (value: Tone): Tone => (stale ? "muted" : value);', "const tone = (value: Tone): Tone => value;"),
    # --- the read-only proof itself (test helpers)
    ("NEW proof hash without ctime", "tests/helpers.ts", "${info.ctimeNs}\\0", ""),
    ("NEW proof hashes the root only", "tests/readonly-proof.test.ts", 'const snapshot = (b: FixtureRoot) => `${hashTree(b.dir, ["/ctl"])}\\n${outside()}`;', "const snapshot = (b: FixtureRoot) => hashTree(b.root);"),
    ("R2 proof ignores temp dirs and HOME (R1)", "tests/readonly-proof.test.ts", 'const snapshot = (b: FixtureRoot) => `${hashTree(b.dir, ["/ctl"])}\\n${outside()}`;', 'const snapshot = (b: FixtureRoot) => hashTree(b.dir, ["/ctl"]);'),
    ("NEW proof does not wait for late writers", "tests/readonly-proof.test.ts", "  await waitForNoProcessWith(`MEUTE_ROOT=${b.root}`, 10_000);\n}", "}"),
    # --- test HOME safety (re-review 08 H1-H4): the harness guards themselves
    ("H1 fs guard not installed", "tests/fs-guard.ts", "\ninstallFsGuard();\n", "\n"),
    ("H1 fs guard ignores promises", "tests/fs-guard.ts", "    wrap(promises, name, name, true);\n", ""),
    ("H1 fs guard lexical (no realpath)", "tests/fs-guard.ts", "const real = resolveReal(text, FOLLOWS.has(name));", "const real = text;"),
    ("H2 proof deletes every rr-proof-escape.* in /tmp", "tests/readonly-proof.test.ts", "    rmSync(escaped, { force: true });\n", '    for (const name of readdirSync("/tmp")) if (name.startsWith("rr-proof-escape.")) rmSync(join("/tmp", name), { force: true });\n'),
    ("H1 vitest.config does not set HOME", "vitest.config.ts", '  HOME: join(root, "home"),\n', ""),
    ("H1 HOME check lexical startsWith", "tests/helpers.ts", "  const real = resolveReal(home);\n", "  const real = home;\n"),
    ("H1 HOME check accepts the real home", "tests/helpers.ts", "if (real === realHome || !isUnder(real, root) || real === root) {", "if (!isUnder(real, root) || real === root) {"),
    ("H1 child HOME check off", "tests/helpers.ts", "  if (parentOf(real) !== resolveReal(tmpdir()) || !basename(real).startsWith(\"meute-fleet-home-\")) {", "  if (false) {"),
    # --- docs
    ("R2 OVERVIEW drops 'one dedicated unix user'", "OVERVIEW.md", "run as one dedicated unix user", "run as a dedicated daemon"),
    ("R2 README drops the PROPOSED marker", "README.md", "(PROPOSED, the owner's decision until confirmed)", "(recommended)"),
]


def run(mutant):
    name, rel, old, new = mutant
    work = tempfile.mkdtemp(prefix="fleet-mut-")
    try:
        for entry in os.listdir(REPO):
            if entry in ("node_modules", ".git", ".test-tmp"):
                continue
            src = os.path.join(REPO, entry)
            (shutil.copytree if os.path.isdir(src) else shutil.copy2)(src, os.path.join(work, entry))
        os.symlink(os.path.join(REPO, "node_modules"), os.path.join(work, "node_modules"))
        path = os.path.join(work, rel)
        text = open(path, encoding="utf8").read()
        if old not in text:
            return name, "BAD-MUTANT (pattern not found)", 0
        open(path, "w", encoding="utf8").write(text.replace(old, new, 1))
        # A private test TMPDIR per mutant (its chain must be owned by this user, see vitest.config.ts),
        # so a mutant run never shares sandboxes or private HOMEs with another suite run.
        mut_base = os.path.join(os.environ.get("FLEET_TEST_TMPDIR") or os.path.join(REPO, ".test-tmp"), "mut")
        os.makedirs(mut_base, mode=0o700, exist_ok=True)
        test_tmp = tempfile.mkdtemp(prefix="run-", dir=mut_base)
        # A mutant may hand the daemon HOME to the child, and tests then change the child HOME: give
        # the suite a throwaway HOME so that can never touch the real one. It sits OUTSIDE the test
        # root, so a mutant that drops the HOME override from vitest.config.ts is refused by globalSetup.
        fake_home = tempfile.mkdtemp(prefix="home-", dir=mut_base)
        try:
            result = subprocess.run(["npx", "vitest", "run", "--testTimeout=20000"], cwd=work, capture_output=True,
                                    text=True, timeout=900,
                                    env=dict(os.environ, FLEET_TEST_TMPDIR=test_tmp, HOME=fake_home))
        except subprocess.TimeoutExpired:
            return name, "KILLED (suite timed out)", 0
        finally:
            shutil.rmtree(test_tmp, ignore_errors=True)
            shutil.rmtree(fake_home, ignore_errors=True)
        failed = [line.strip() for line in result.stdout.splitlines() if line.strip().startswith("×")]
        return name, ("KILLED" if result.returncode != 0 else "SURVIVED"), len(failed), failed[:2]
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    if "--list" in sys.argv:
        for m in MUTANTS:
            print(m[0])
        sys.exit(0)
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else ""
    selected = [m for m in MUTANTS if only in m[0]]
    survivors = 0
    for mutant in selected:
        outcome = run(mutant)
        print(" | ".join(str(x) for x in outcome), flush=True)
        if outcome[1] != "KILLED":
            survivors += 1
    print(f"{len(selected) - survivors}/{len(selected)} mutants killed")
    sys.exit(1 if survivors else 0)

# meute-fleet: Paseo plugin, slice 0 (read-only)

A read-only operator view of [Meute](https://github.com/bearyjd/meute) for [Paseo](https://paseo.sh) 0.17.x
(`requirements.paseo: ">=0.17.0 <0.18.0"`). Local only. Nothing in this repo pushes, publishes, or installs
onto any machine.

## Threat model (read this before installing)

- **Plugins run unsandboxed, as the daemon user.** This plugin's guards limit what *it* does; any other
  plugin, agent or process running as the same unix user can read and rewrite this plugin, the Meute tree
  and `bin/meute`, and read `/proc/*/environ`. A second daemon under the same unix user isolates nothing.
- **Supported deployment (PROPOSED, the owner's decision until confirmed):** Meute and the operator Paseo daemon
  run as **one dedicated unix user**. Nothing else runs as that user: no third-party plugins, no other humans, no
  other services. The daemon is exposed on the tailnet or a VPN only, never on a public interface. Timer health
  works only when the daemon user owns the user bus, which it does in this layout because the Meute timers are
  that user's own.
- **Deployment prerequisite, not enforced by the plugin:** nobody but that operator user can write the Meute tree
  or the daemon user's files. A plugin cannot defend against someone who can already do that; the guards below
  catch mistakes in the layout and close known holes, they are not isolation.
- **No separate-user or group layout.** An earlier draft proposed a separate operator user reading the fleet's
  data through a group (`state/`, `reports/` group-readable). That cannot work: meute sets `umask 077`
  (`bin/meute:87`, `bin/run.sh:54`) and adds no group bits, so every report and state file it writes is 0600 and a
  second uid sees every section as `unavailable`.
- **A paired device is the operator.** Paseo gives plugins no caller identity: every client with
  `daemon.manage` can call these RPCs and can already install plugins (arbitrary code as the daemon user).
- **Settings are writable by any client with `daemon.manage`**, so the binary path, MEUTE_ROOT, PATH and
  XDG_RUNTIME_DIR are a trust decision. They are re-checked on every call (see "Enforced before every spawn"),
  but a writer of the settings chooses which Meute tree runs.

## What slice 0 does

A **Fleet** screen (sidebar item plus screen) with four sections:

| Section | Source | Poll |
|---|---|---|
| Inbox: list with filters (state new/open/dismissed, severity) and a repo picker (one or more repos, "All repos" by default; the repos are the ones in the findings answer, i.e. the `reports/<repo>/` directories meute scanned, so a repo with no report is not listed; the choice is remembered on this client only, in memory and the host's localStorage when it has one, never sent to the daemon; names that are not plain path segments are not offered or stored). A row is `repo/report#n`, title, severity, state. A list, not a table, so it works on a phone. | `meute findings --all --json` | 30 s |
| Finding: the report excerpt as escaped plain text | `reports/<repo>/<name>.md` read directly, never `meute show` (which marks the report read) | on open |
| Readiness: per-check status, pending vs ready, fail-closed wording | `meute readiness validate` JSON | 60 s |
| Health & run: healthy/unhealthy, lock holder, recent log lines, queue size | `meute health`; files `state/lock-info`, `state/log`, `state/plan-queue.json` | 60 s / 10 s |

Polling runs only while the section is mounted and the app is in the foreground, one loop per section (a Refresh
during a call queues one re-run), and backs off exponentially (cap 120 s) after failures. Every section shows
`as of HH:MM` (with the date if not today). Data is stale when a call failed (`Stale since HH:MM`, or `Unavailable`),
when the answer is older than 2x the poll period, or after a resume from background until the new answer arrives;
stale data loses every success colour. Old data is dropped at the first failure that comes more than 5 minutes after the last success. Readiness fails closed: any
error reads `UNKNOWN: treat as NOT READY`, a stale READY reads `Last answer READY, not current: treat as NOT READY`,
and ready with zero checks is never READY.

There are exactly five RPCs (`fleet.findings.list`, `fleet.finding.get`, `fleet.readiness.get`, `fleet.health.get`,
`fleet.run.status`). Receipts, decisions (resolve/dismiss/promote/claim) and run start/stop are not registered. A
test fails if any other server API or RPC appears.

## Allowlisted meute commands (the complete list, `server/runner.ts`)

| id | argv (exec'd directly, no shell) | accepted exit codes |
|---|---|---|
| `findings_list` | `meute findings --all --json` | 0 |
| `health` | `meute health` | 0, 1 |
| `readiness_validate` | `meute readiness validate <record> --owner-policy <policy>` | 0, 1, 2 |

`<record>` and `<policy>` come from the plugin settings (which any `daemon.manage` client can write, see the threat
model), never from RPC input, and must pass a strict absolute-path validator. Everything else (show, `findings verify`, `branches --prune`, resolve, dismiss, promote, claim, run, drain,
plan/enqueue, pause/policy, install-timers, doctor, image, discover, evidence export, status, reports, tui/web) is
unreachable; `tests/runner.test.ts` enumerates them.

Files read (`server/safefs.ts`), all under MEUTE_ROOT: `reports/<repo>/<name>.md`, `state/lock-info`, `state/log`
(last bytes only), `state/plan-queue.json`.

## Safety design

- One module, `server/runner.ts`, may spawn processes (`tests/structure.test.ts` greps for it). `spawn` with
  `shell: false`, a frozen allowlist looked up with `Object.hasOwn`, params checked against a strict validator.
- **Enforced before every spawn** (not only when settings are saved; `server/config.ts`, `server/tree.ts`,
  `server/session.ts`). A failure reads `Unsafe configuration: ...` and no child is started.
  - `meutePath` is exactly `<MEUTE_ROOT>/bin/meute` with no symlink in any component: a regular executable owned by
    the daemon user or root and not group/other writable.
  - MEUTE_ROOT itself gets the same rule as every entry of the tree: owned by the daemon user or root and not
    group/other writable, and the sticky bit is no exemption for it (another uid could otherwise add top-level names
    such as `state/` or `repos.local.yaml`).
  - Every directory above MEUTE_ROOT, up to `/`, is owned by the daemon user or root. The sticky bit exempts a
    directory above MEUTE_ROOT only from the not-group/other-writable rule, never from the owner check (the owner of
    a sticky directory can still replace its entries).
  - The whole Meute code tree is walked: every entry under MEUTE_ROOT (`bin/`, `lib/` including `__pycache__`,
    `tasks/`, `repos.yaml`, `.git/config` and hooks, everything else) must be a regular file or a directory (no
    symlink, FIFO, socket or device), owned by the daemon user or root, and not group/other writable. Not walked:
    `state/`, `reports/`, `.worktrees/` at the top (data meute writes) and `.git/objects`, `.git/refs`, `.git/logs`
    (git data; the three allowlisted commands never run git in MEUTE_ROOT). More than 20 000 entries fails closed.
    Every entry is `lstat`ed on every call (a mode change shows only in that file's ctime); only directory
    listings are cached, by (path, inode, mtime, ctime, size). About 5 ms on meute's own tree. A refusal names the
    entry relative to MEUTE_ROOT (for example `... writable by group or others: lib/health.sh`, sanitized), never
    a host path; directories above MEUTE_ROOT are not named.
  - Each configured PATH directory is a real directory (no symlink) owned by the daemon user or root, not
    group/other writable, with a directory chain that passes the ancestor rule.
- Child environment is built from nothing: `PATH` (default `/usr/local/bin:/usr/bin:/bin`), `USER`,
  `LC_ALL=C.UTF-8`, `MEUTE_ROOT`, and:
  - `HOME` is always a **private, empty directory** the plugin makes with `mkdtemp` in the daemon's temp dir:
    owned by the daemon user, mode 0700, re-verified (and replaced if changed or non-empty) before every spawn.
    The daemon's calls share it while it stays intact. A replaced HOME is removed (recursively only while it is
    still a 0700 directory of the daemon user, otherwise only if empty), and the current one when the daemon
    process exits. A HOME that fails the checks right after `mkdtemp` is removed at once, and the call fails with
    `No private HOME could be made for Meute: the daemon's temp dir (TMPDIR, default /tmp) or a directory above it
    is owned by another user or open to others; set TMPDIR for the daemon to a private directory`.
    HOME is not configurable: meute runs `python3` without `-I` and runs git, which load code from HOME (user
    site-packages `.pth` files, `~/.gitconfig`). `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME` point
    inside it. meute's health reads HOME only for the install time of `meute-daily.timer` and then falls back to
    the mtime of `state/` (`lib/health.sh:57-58`).
  - `PYTHONNOUSERSITE=1`, `PYTHONDONTWRITEBYTECODE=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`
    (readiness strips `GIT_*` for its own git calls, so there the private HOME is what keeps a user gitconfig out).
  - `XDG_RUNTIME_DIR` only while, at that call, it is a directory owned by the daemon user with no group/other
    bits, holding a `bus` socket owned by the daemon user that accepts a connection within 1 s. Otherwise it is
    left out.
  - No daemon variable reaches the child (canary test with 18 variables).
- cwd is MEUTE_ROOT. Timeout 15 s (clamped to 20 s): SIGTERM to the process group, SIGKILL after 2 s, and the call
  settles at timeout + grace + 0.5 s at the latest even if a descendant that left the group holds the pipes (which are
  then destroyed). A leader that exits while a descendant keeps its output open is an error after 2 s, never a clean
  answer. No bare-pid signal is sent after the leader exited. stdout and stderr are capped at 2 MiB each; exceeding it
  kills the group and returns `truncated`. Identical concurrent calls (same argv, PATH, XDG_RUNTIME_DIR setting and timeout) share one child; at
  most 4 children run at once, further calls are refused as `unavailable`.
- Failures become `{ok:false, error:{code,message}}` envelopes. Messages are fixed strings; text that comes from
  meute (health lines, readiness `detail`/`scope`, lock-info, log fields) is ANSI/control/bidi-stripped and has
  absolute paths replaced by `<path>` (configured paths are replaced whole, spaces included).
- Reads walk the path one component at a time from a descriptor of the root (`/proc/self/fd/<dir>/<name>`, each
  opened with `O_NOFOLLOW`), so no symlink is followed below the root even if a directory is swapped during the
  walk; the opened file must then resolve to exactly the expected path, and `fstat` must show a regular file with one
  hard link within the cap (reports 4 MiB, queue 1 MiB, lock-info 4 KiB, log tail 64 KiB default and 256 KiB max).
  FIFOs and devices are refused without blocking; a dangling link is `unsafe_path`. Reports must be valid UTF-8, like
  meute requires.
- Finding numbering reproduces meute's Python regex exactly (`^` only after `\n`, Python's `\s`, `.` as `[^\n]`),
  checked by a differential test against meute's own `lib/report.py`.
- Every external payload is parsed with zod. Unknown fields are tolerated, malformed input is a structured error.
- Health is healthy only for exit 0 with byte-empty stdout and stderr **and** the runner's report that this very
  child was given XDG_RUNTIME_DIR (the check above, including the connect, made right before its spawn; health
  makes no bus probe of its own). Otherwise it is `unknown` (never green): without the user bus
  `systemctl --user` fails and meute prints nothing, which looks exactly like a healthy fleet, and a leftover `bus`
  socket of a dead user manager is refused by the connect.

## Configure

Settings, Meute Fleet (host scope). There are no defaults and nothing is searched for.

- `MEUTE_ROOT`: absolute path of the Meute checkout. `meute binary`: must be exactly `<MEUTE_ROOT>/bin/meute`
  (meute derives its root from its own location, so the CLI and the file reads cannot diverge). The checkout and
  every directory above it must pass the checks above: owned by the daemon user (or root) and not group/other
  writable (above MEUTE_ROOT, a sticky directory such as `/tmp` may be world-writable).
- Readiness record and owner policy JSON paths (optional; without them readiness says `NOT CONFIGURED`).
- Optional PATH and XDG_RUNTIME_DIR for meute. `meute health` calls `systemctl --user`, which needs the daemon
  user's own runtime dir (for example `/run/user/<uid>`, with `loginctl enable-linger` for a user without a login
  session). Without it health reads `unknown`. There is no HOME setting (see above); a stored `homeDir` from an
  older version is ignored.

## Develop and test

```
npm install
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm test               # vitest: runner, safefs, parsers, service, read-only proof, structure, view-model, hook, screens
MEUTE_SOURCE_DIR=/path/to/meute npm test   # also runs the real-meute tests (copied checkout)
python3 scripts/mutation-check.py   # mutants of the guards, each run against the full suite in a throwaway copy
```

`tests/fixtures/captured/` holds real output of Meute main 2840bdb (`findings --all --json`, `readiness validate`
ready/pending/invalid, `health`). `tests/fixtures/meute-root/` is a Meute layout (reports plus state) that tests copy to
a temp dir, run every RPC against, and hash (path, mode, size, mtime in ns, content, link count) before and after. The
proof also hashes ctime and inode (so xattr, chmod round trips and restored-mtime rewrites show), the root's parent
and a sibling directory, flags top-level entries added to the temp dirs (`os.tmpdir()` and `/tmp`) and any file in
the child's private HOME, and waits until no process carrying that MEUTE_ROOT is left before hashing. Test sandboxes
live in `<repo>/.test-tmp/root` (override the parent with `FLEET_TEST_TMPDIR`; never `/tmp`, because the ancestor
rule refuses a `/tmp` owned by an unmapped uid, as rootless user namespaces show it).

Test HOME safety has one chokepoint: `vitest.config.ts` points `HOME`, `XDG_{CONFIG,DATA,CACHE,STATE}_HOME`,
`XDG_RUNTIME_DIR` and `TMPDIR` at 0700 directories under that root; `tests/global-setup.ts` and every worker refuse
to start unless HOME really (by realpath) lies under it and is not your home; `tests/fs-guard.ts` makes
chmod/chown/rm/rmdir/rename/unlink (sync, callback and promises) throw for any real path outside the root. A test
that must touch one outside path calls `allowOutsideTestRoot(path)` from `tests/helpers.ts` and releases it after.
Child processes (the bash stubs) are not covered by the wrapper. `scripts/mutation-check.py` keeps its own dirs
under `FLEET_TEST_TMPDIR` and gives each mutant a throwaway HOME outside the test root. The real-meute
tests run only when `MEUTE_SOURCE_DIR` is set (no default); otherwise they are reported as skipped with the reason,
and a set but unusable value fails.

## Load into a LOCAL dev Paseo

The paseo CLI is not installed on the machine that built this, so loading was not exercised (see UNVERIFIED in the
build report). On a dev machine with Paseo 0.17.x, using a throwaway home and a fixture root, never your real state:

```
export PASEO_HOME=$(mktemp -d)           # temp daemon state; every paseo command below must run in this shell
FLEET_ROOT=$(mktemp -d)/root && cp -r tests/fixtures/meute-root "$FLEET_ROOT"   # then copy a meute checkout's bin/ lib/ in
paseo plugin install /path/to/meute-fleet-plugin  # local directory install
paseo plugin reload meute-fleet && paseo plugin logs meute-fleet
```

Enable `pluginsEnabled` in that daemon's config, set the plugin settings to the temp root, and stop the daemon
afterwards. Do not point it at a real MEUTE_ROOT, and do not install on any shared host.

## Known limits

What is not enforced, and why. Each is either a deployment prerequisite or left for a later slice.

1. **Same-uid code defeats every guard** (deployment prerequisite). Any process of the daemon user can rewrite the
   plugin, the tree or the settings, and swap files between a check and the exec. The checks catch layout mistakes
   and other uids; they are not isolation.
2. **Settings writers choose the tree.** Any `daemon.manage` client can point the plugin at another tree, PATH or
   runtime dir that passes the checks.
3. **What the walk leaves out**: `state/`, `reports/`, `.worktrees/` and `.git/{objects,refs,logs}`. meute treats
   them as data (state files are parsed by python, never sourced); a future meute that executes from them would
   need the walk widened. The skipped top-level dirs are not checked themselves either (not even `lstat`): a
   `state/` symlink or a 0777 `reports/` passes, and another uid able to write there can forge health or findings
   data (not run code).
4. **Interpreters and tools come from PATH.** The PATH directories are checked, not each binary in them (a
   `python3` symlink inside a valid directory is followed), and the default PATH is not validated (root-owned
   system directories are trusted). Python's stdlib, system site-packages and git are trusted the same way.
5. **XDG_RUNTIME_DIR**: only the directory and its `bus` socket are checked, not the directories above it. A live
   listener proves a bus, not that `systemctl` answered; a `systemctl` that fails on a trusted PATH is still not
   seen (meute's `nobus` state prints nothing; the fix belongs upstream). A bus that dies after the runner's probe
   but before meute's `systemctl` runs (milliseconds) still reads healthy.
6. **Private HOMEs**: up to 4 concurrent children share one HOME (same trust domain; one HOME per daemon process). A
   daemon killed without an exit leaves its one HOME in the temp dir, and a replaced HOME that is neither 0700 nor
   empty (only the daemon user or root can make it so) is left for the temp dir's cleaner. With an empty
   `state/log`, meute's "never fired" timing uses the mtime of `state/` (there is no timer unit file in the private
   HOME).
   A replaced HOME is removed when the next call finds it non-empty, even if another child is still running in it,
   so a concurrent child that writes into `$HOME` can fail or recreate it (no per-HOME use count yet; all
   involved paths belong to the daemon user).
7. **Read-only proof blind spots**: deep writes into existing temp directories, removals in `/tmp`, temp files
   that vanish within a second (ignored because other programs make them), writes
   elsewhere on the filesystem, and late writers that drop MEUTE_ROOT from their environment (`setsid env -i`)
   are not seen. The readiness evaluation branch of the real CLI is read-only by code reading only.
8. **Processes**: detached descendants can outlive a call (the slot is freed when the call settles); a group kill
   sent shortly after a group emptied could hit a reused process-group id (very small window).
9. **Reads and parsing (low)**: a symlinked MEUTE_ROOT path is resolved by the file reader (the spawn check refuses
   it); lock-info keys are not anchored (`fake_pid=` matches); `\r` inside a log field becomes a line break; a few
   invisible format characters survive sanitizing; one malformed plan-queue entry hides the whole queue, and so
   does a queue of more than 10 000 entries.
10. **Client (low)**: polling continues while the screen is covered by another route (Paseo exposes no focus
    signal); a stale Health headline keeps its text (only the colour changes); every client error reads as "the
    daemon did not answer"; Save stays enabled during a settings conflict (the host rejects it) and Reset has no
    confirmation.
11. **Legitimate trees that are refused** (deployment limit): a socket in the checkout (git's built-in fsmonitor,
    `.git/fsmonitor--daemon.ipc`) is a "special file"; more than 20 000 walked entries (for example
    `.git/modules/*/objects`, which are not skipped) fails closed. meute's own checkout has about 200 entries.
12. **Logs and fonts (low)**: the server log carries only `error.name` of an unexpected error, not its message or
    stack (no host paths in logs, but little to debug with). Report excerpts and log lines use `fontFamily:
    "monospace"`, which iOS does not resolve to a monospaced font (needs a real-device check).
13. **Client staleness (low)**: on iOS the `inactive` app state (control centre, app switcher) keeps polling; an
    open finding detail never ages (it shows "as of" only, it is not marked stale); on resume, one frame of old
    data is drawn before it is marked stale.
14. **Dev only (low)**: `react-test-renderer` is `^19.1.0` while `react` is pinned to `19.1.0`, so a fresh install
    may pair different patch versions in tests. The runner's dedup key leaves out `graceMs` and `maxOutputBytes`
    (internal, not settable from settings).

## License and provenance

AGPL-3.0-only (see `LICENSE`), the same license as Meute. `server/parsers.ts` ports parsing logic from Meute's
`report.py` and `inbox.py`. The plugin API (`@getpaseo/plugin`) is Apache-2.0.

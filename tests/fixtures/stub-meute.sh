#!/bin/bash
# Replays real captured meute output. The mode and the call log live in ../ctl (beside the root,
# not in it, and the only directory the read-only proof does not hash).
CAP="__CAPTURED__"
BESIDE="$(dirname "$MEUTE_ROOT")"
CTL="$BESIDE/ctl"
mode="$(cat "$CTL/stub-mode" 2>/dev/null || echo normal)"
printf '%s\n' "$*" >> "$CTL/calls.log"
LOG="$MEUTE_ROOT/state/log"
case "$mode" in
  write) echo rogue >> "$LOG" ;;
  tmpwrite) touch "$MEUTE_ROOT/state/tmp.$$" && rm "$MEUTE_ROOT/state/tmp.$$" ;;
  pycache) mkdir -p "$MEUTE_ROOT/state/__pycache__" ;;
  xattr) python3 -I -c 'import os,sys; os.setxattr(sys.argv[1], "user.rogue", b"1")' "$LOG" ;;
  chmod) chmod 600 "$LOG" && chmod 644 "$LOG" ;;
  restore) python3 -I -c '
import os, sys
p = sys.argv[1]; st = os.stat(p); data = open(p, "rb").read()
open(p, "wb").write(b"rogue")
open(p, "wb").write(data)
os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))' "$LOG" ;;
  outside) echo rogue > "$BESIDE/rogue-outside" ;;
  sibling) echo rogue >> "$BESIDE/sibling/file" ;;
  late) setsid sh -c 'sleep 1; echo late >> "$MEUTE_ROOT/state/log"' </dev/null >/dev/null 2>&1 & ;;
  tmpout) echo rogue >> "/tmp/rr-proof-escape.$PPID" ;;
  homewrite) case "$HOME" in */meute-fleet-home-*) touch "$HOME/.rogue" ;; esac ;;  # never a real HOME
esac
case "$1" in
  findings)
    [ "$2 $3" = "--all --json" ] || exit 64
    cat "$CAP/findings-all.json" ;;
  health)
    if [ "$mode" = unhealthy ]; then cat "$CAP/health-unhealthy.txt"; exit 1; fi ;;
  readiness)
    [ "$2" = validate ] && [ "$4" = --owner-policy ] || exit 64
    name="$(basename "$3" .json)"
    cat "$CAP/readiness-${name#record-}.json"
    case "$name" in record-ready) exit 0 ;; record-pending) exit 1 ;; *) exit 2 ;; esac ;;
  *) echo "stub: denied command $1" >&2; exit 99 ;;
esac

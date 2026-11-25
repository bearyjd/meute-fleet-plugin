import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import type { Envelope } from "../shared/contracts";
import {
  INITIAL_POLL, markResumed, nextDelayMs, reducePoll, STALE_AFTER_PERIODS, type PollOutcome, type PollState,
} from "./viewmodel";

// One predicate for the initial state and for change events ("inactive" still counts as visible).
const isForeground = (state: string | null | undefined): boolean => state !== "background";

/** True while the app is in the foreground. Polling pauses when it is not. */
function useForeground(): boolean {
  const [active, setActive] = useState(isForeground(AppState.currentState));
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => setActive(isForeground(next)));
    return () => subscription.remove();
  }, []);
  return active;
}

const noop = () => undefined;

/**
 * Calls an RPC while the surface is mounted and the app is visible, backing off after failures.
 * `baseMs: null` fetches once (and on refresh()). There is one loop per effect run: refresh()
 * during a call queues a single re-run instead of starting another loop, and an answer from a
 * cancelled run (backgrounded, unmounted, input changed) is dropped. `now` is re-read when an
 * answer arrives and when the held answer crosses the stale-by-age threshold, so the view
 * downgrades even if a call hangs.
 */
export function usePolled<Input, Data>(
  call: (input: Input) => Promise<Envelope<Data>>,
  input: Input,
  baseMs: number | null,
): { state: PollState<Data>; loading: boolean; now: number; refresh(): void } {
  const [state, setState] = useState<PollState<Data>>(INITIAL_POLL);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const callRef = useRef(call);
  callRef.current = call;
  const inputRef = useRef(input);
  inputRef.current = input;
  const refreshRef = useRef<() => void>(noop);
  const foreground = useForeground();
  const inputKey = JSON.stringify(input);

  useEffect(() => {
    if (!foreground) return undefined;
    let cancelled = false;
    let failures = 0;
    let inFlight = false;
    let rerun = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Anything held now predates this polling session (resume, input change).
    setState((previous) => markResumed(previous));

    const run = async () => {
      inFlight = true;
      setLoading(true);
      let outcome: PollOutcome<Data>;
      try {
        const answer = await callRef.current(inputRef.current);
        outcome = answer.ok
          ? { ok: true, data: answer.data, observedAt: answer.observedAt }
          : { ok: false, error: answer.error };
      } catch {
        outcome = { ok: false, error: { code: "unavailable", message: "The Paseo daemon did not answer" } };
      }
      inFlight = false;
      if (cancelled) return;
      failures = outcome.ok ? 0 : failures + 1;
      const at = Date.now();
      setState((previous) => reducePoll(previous, outcome, at));
      setNow(at);
      setLoading(false);
      if (rerun) {
        rerun = false;
        void run();
        return;
      }
      if (baseMs !== null) timer = setTimeout(() => void run(), nextDelayMs(baseMs, failures));
    };

    refreshRef.current = () => {
      if (inFlight) {
        rerun = true;
        return;
      }
      if (timer) clearTimeout(timer);
      timer = undefined;
      void run();
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      refreshRef.current = noop; // a refresh while backgrounded must not run a dead loop
      setLoading(false);
    };
  }, [foreground, baseMs, inputKey]);

  // Re-render when the held answer becomes too old, even if no answer arrives meanwhile.
  const lastOkAt = state.lastOkAt;
  useEffect(() => {
    if (!foreground || baseMs === null || lastOkAt === undefined) return undefined;
    const due = lastOkAt + STALE_AFTER_PERIODS * baseMs + 1 - Date.now();
    const tick = setTimeout(() => setNow(Date.now()), Math.max(0, due));
    return () => clearTimeout(tick);
  }, [foreground, baseMs, lastOkAt]);

  const refresh = useCallback(() => refreshRef.current(), []);
  return { state, loading, now, refresh };
}

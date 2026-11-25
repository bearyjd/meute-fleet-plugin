// The polling hook (review 06 paseo F2/F3, tests C5, verifier M1/M2): foreground pause, resume,
// unmount, refresh storms, out-of-order answers, and staleness that appears with no answer.
import TestRenderer, { act, type Renderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Envelope } from "../shared/contracts";

const app = vi.hoisted(() => ({ state: "active", listeners: [] as Array<(next: string) => void> }));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return app.state;
    },
    addEventListener: (_event: string, listener: (next: string) => void) => {
      app.listeners.push(listener);
      return { remove: () => { app.listeners = app.listeners.filter((entry) => entry !== listener); } };
    },
  },
}));

import { usePolled } from "../client/use-polled";
import { freshness } from "../client/viewmodel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Api = ReturnType<typeof usePolled<{ q: number }, string>>;
interface Pending { input: { q: number }; resolve(answer: Envelope<string>): void }

let pending: Pending[] = [];
let api: Api;
let root: Renderer | undefined;
const call = vi.fn((input: { q: number }) => new Promise<Envelope<string>>((resolve) => pending.push({ input, resolve })));
const okAnswer = (data: string): Envelope<string> => ({ ok: true, observedAt: "t", data });
const BASE = 10_000;

function Probe({ q, base = BASE }: { q: number; base?: number | null }) {
  api = usePolled(call, { q }, base);
  return null;
}
const mount = async (q = 1, base: number | null = BASE) => {
  await act(async () => { root = TestRenderer.create(<Probe q={q} base={base} />); });
};
const answerAll = async (data: string) => {
  const batch = pending.splice(0);
  await act(async () => { for (const entry of batch) entry.resolve(okAnswer(data)); });
};
const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };
const setApp = async (next: string) => {
  app.state = next;
  await act(async () => { for (const listener of [...app.listeners]) listener(next); });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 25, 9, 0));
  app.state = "active";
  app.listeners = [];
  pending = [];
  call.mockClear();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.useRealTimers();
});

describe("usePolled", () => {
  it("polls once per period after an answer", async () => {
    await mount();
    expect(call).toHaveBeenCalledTimes(1);
    await answerAll("a");
    await advance(BASE);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("refresh while a call is in flight does not start a second loop (refresh storm)", async () => {
    await mount();
    for (let i = 0; i < 10; i++) await act(async () => api.refresh());
    expect(call).toHaveBeenCalledTimes(1);
    await answerAll("a"); // the queued refresh runs once, now
    expect(call).toHaveBeenCalledTimes(2);
    await answerAll("b");
    await advance(BASE);
    expect(call).toHaveBeenCalledTimes(3); // one loop: one call per period
    await answerAll("c");
    await advance(BASE);
    expect(call).toHaveBeenCalledTimes(4);
  });

  it("pauses in the background, then resumes with the old data marked stale until the answer", async () => {
    await mount();
    await answerAll("old");
    await setApp("background");
    await advance(3 * 60 * 60 * 1000);
    expect(call).toHaveBeenCalledTimes(1);
    await setApp("active");
    expect(call).toHaveBeenCalledTimes(2);
    expect(api.state.data).toBe("old");
    expect(freshness(api.state, api.now, BASE).stale).toBe(true);
    await answerAll("new");
    expect(api.state.data).toBe("new");
    expect(freshness(api.state, api.now, BASE).stale).toBe(false);
  });

  it("refresh while backgrounded does nothing (no call from a dead loop)", async () => {
    await mount();
    await answerAll("a");
    await setApp("background");
    await act(async () => api.refresh());
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("loading is not stuck when a call is cancelled by backgrounding", async () => {
    await mount();
    expect(api.loading).toBe(true);
    await setApp("background");
    expect(api.loading).toBe(false);
  });

  it("goes stale by age while a call hangs, with no answer arriving", async () => {
    await mount();
    await answerAll("a");
    await advance(BASE); // next call starts and never answers
    expect(call).toHaveBeenCalledTimes(2);
    expect(freshness(api.state, api.now, BASE).stale).toBe(false);
    await advance(BASE + 1);
    expect(freshness(api.state, api.now, BASE).stale).toBe(true);
  });

  it("drops an answer that arrives after the input changed (out of order)", async () => {
    await mount(1);
    await act(async () => root!.update(<Probe q={2} />));
    expect(pending.map((entry) => entry.input.q)).toEqual([1, 2]);
    const [first, second] = pending.splice(0);
    await act(async () => second!.resolve(okAnswer("for-2")));
    await act(async () => first!.resolve(okAnswer("for-1")));
    expect(api.state.data).toBe("for-2");
  });

  it("makes no call after unmount", async () => {
    await mount();
    await answerAll("a");
    await act(async () => root!.unmount());
    root = undefined;
    await advance(10 * BASE);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("a one-shot fetch (no period) does not poll", async () => {
    await mount(1, null);
    await answerAll("a");
    await advance(10 * BASE);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

// Screen-level checks with react-test-renderer. react-native and the Paseo UI kit are replaced by
// plain host elements, so this proves the component logic, not real native rendering.
import { createElement, type ReactNode } from "react";
import TestRenderer, { act, type Renderer, type TestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Envelope, HealthData, ReadinessData } from "../shared/contracts";

const host = vi.hoisted(() => ({ pending: [] as Array<{ name: string; resolve(answer: unknown): void }> }));
vi.mock("react-native", () => {
  const element = (name: string) => (props: { children?: ReactNode }) => createElement(name, props, props.children);
  return {
    AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
    Text: element("Text"), View: element("View"), Pressable: element("Pressable"),
  };
});
vi.mock("@getpaseo/plugin/client/ui", () => ({
  ScrollView: (props: { children?: ReactNode }) => createElement("ScrollView", null, props.children),
  FlatList: (props: { data: unknown[]; renderItem(info: { item: unknown }): ReactNode; ListHeaderComponent?: ReactNode }) =>
    createElement("FlatList", null, props.ListHeaderComponent, ...props.data.map((item) => props.renderItem({ item }))),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => () => new Promise((resolve) => host.pending.push({ name: contract.name, resolve })),
}));

import { Inbox } from "../client/inbox";
import { repoSelection } from "../client/repo-selection";
import { Readiness } from "../client/readiness";
import { HealthAndRun } from "../client/run";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const theme = {
  colors: {
    statusSuccess: "SUCCESS", statusWarning: "WARNING", statusDanger: "DANGER", foreground: "FG", foregroundMuted: "MUTED",
    surface1: "S1", border: "B", accent: "A", accentForeground: "AF",
  },
} as never;
const READY: ReadinessData = { verdict: "ready", exitCode: 0, version: 1, checks: [{ check: "a", status: "passed", reason: "ok" }] };
const ok = <D,>(data: D): Envelope<D> => ({ ok: true, observedAt: new Date().toISOString(), data });

let root: Renderer | undefined;
const texts = (r: Renderer) =>
  r.root.findAll((node: TestInstance) => node.type === "Text").map((node) => ({
    text: [node.props["children"]].flat().join(""),
    color: (node.props["style"] as { color?: string } | undefined)?.color,
  }));
const answer = async (name: string, value: unknown) => {
  const index = host.pending.findIndex((entry) => entry.name === name);
  const [entry] = host.pending.splice(index, 1);
  await act(async () => entry!.resolve(value));
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 25, 9, 0));
  host.pending = [];
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.useRealTimers();
});

describe("Readiness screen", () => {
  it("shows READY in the success colour with 'as of', then drops the colour when the answer ages", async () => {
    await act(async () => { root = TestRenderer.create(<Readiness theme={theme} compact />); });
    await answer("fleet.readiness.get", ok(READY));
    expect(texts(root!)).toContainEqual({ text: "READY", color: "SUCCESS" });
    expect(texts(root!).some((entry) => entry.text === "as of 09:00")).toBe(true);
    await act(async () => { vi.advanceTimersByTime(60_000); }); // next poll starts and hangs
    await act(async () => { vi.advanceTimersByTime(60_001); });
    const shown = texts(root!);
    expect(shown.some((entry) => entry.color === "SUCCESS")).toBe(false);
    expect(shown.some((entry) => /treat as NOT READY/.test(entry.text))).toBe(true);
    expect(shown.some((entry) => /^Stale: last answer as of 09:00/.test(entry.text))).toBe(true);
  });

  it("zero checks never renders READY", async () => {
    await act(async () => { root = TestRenderer.create(<Readiness theme={theme} compact />); });
    await answer("fleet.readiness.get", ok({ ...READY, checks: [] }));
    const shown = texts(root!);
    expect(shown.some((entry) => entry.text === "READY" || /All 0/.test(entry.text))).toBe(false);
  });
});

describe("Health card", () => {
  it("healthy loses its success colour once stale", async () => {
    await act(async () => { root = TestRenderer.create(<HealthAndRun theme={theme} compact />); });
    await answer("fleet.health.get", ok<HealthData>({ state: "healthy", problems: [] }));
    expect(texts(root!)).toContainEqual({ text: "Healthy", color: "SUCCESS" });
    await act(async () => { vi.advanceTimersByTime(120_001); });
    expect(texts(root!).find((entry) => entry.text === "Healthy")?.color).toBe("MUTED");
  });
});

describe("Run card", () => {
  it("'No run holds the lock' loses its success colour once stale", async () => {
    await act(async () => { root = TestRenderer.create(<HealthAndRun theme={theme} compact />); });
    await answer("fleet.run.status", ok({
      lock: { ok: true, data: { state: "none" } },
      log: { ok: true, data: { size: 0, partial: false, entries: [] } },
      queue: { ok: true, data: { present: false, size: 0, names: [] } },
    }));
    expect(texts(root!)).toContainEqual({ text: "No run holds the lock", color: "SUCCESS" });
    await act(async () => { vi.advanceTimersByTime(10_000); }); // next poll hangs
    await act(async () => { vi.advanceTimersByTime(10_001); });
    expect(texts(root!).find((entry) => entry.text === "No run holds the lock")?.color).toBe("MUTED");
  });
});

describe("Inbox screen (re-review 07 paseo N12)", () => {
  const finding = { id: "sample/r#1", report: "r", n: 1, repo: "sample", severity: "HIGH", title: "Bad thing", location: "", state: "dismissed", inherited: "", verdict: "" };

  it("keeps the alert banner outside the scrolling list, and rows announce state and staleness", async () => {
    await act(async () => { root = TestRenderer.create(createElement(Inbox, { theme, compact: true, onSelect: () => undefined })); });
    await answer("fleet.findings.list", ok({ findings: [finding], skipped: 0 }));
    const row = () => root!.root.findAll((n: TestInstance) => n.type === "Pressable" && String(n.props["accessibilityLabel"]).includes("sample/r#1"))[0];
    expect(row()?.props["accessibilityLabel"]).toBe("HIGH sample/r#1: Bad thing, dismissed");
    expect(row()?.props["style"]).toMatchObject({ opacity: 1 });
    await act(async () => { vi.advanceTimersByTime(30_000 * 2 + 1_000); }); // the next poll hangs: the answer ages
    const banner = root!.root.findAll((n: TestInstance) => n.type === "View" && n.props["accessibilityRole"] === "alert");
    expect(banner.length).toBe(1);
    // C1: announced when it appears (Android TalkBack needs a live region; iOS reads role alert).
    expect(banner[0]!.props["accessibilityLiveRegion"]).toBe("polite");
    // U6: stale rows are dimmed.
    expect(row()?.props["style"]).toMatchObject({ opacity: 0.5 });
    const list = root!.root.findAll((n: TestInstance) => n.type === "FlatList")[0]!;
    expect(list.findAll((n: TestInstance) => n.props["accessibilityRole"] === "alert")).toEqual([]);
    expect(row()?.props["accessibilityLabel"]).toBe("HIGH sample/r#1: Bad thing, dismissed, not current");
  });
});

describe("Inbox repo picker", () => {
  const mk = (repo: string, n: number) => ({ id: `${repo}/r#${n}`, report: "r", n, repo, severity: "HIGH", title: `T ${repo}`, location: "", state: "new", inherited: "", verdict: "" });
  const findings = [mk("alpha", 1), mk("beta", 1), mk("gamma", 1)];
  const rows = () => root!.root.findAll((n: TestInstance) => n.type === "Pressable" && /#\d+:/.test(String(n.props["accessibilityLabel"])));
  const chip = (label: string) => root!.root.findAll((n: TestInstance) => n.type === "Pressable" && n.props["accessibilityLabel"] === label)[0]!;
  const press = (label: string) => act(async () => (chip(label).props["onPress"] as () => void)());
  const mount = async () => {
    await act(async () => { root = TestRenderer.create(createElement(Inbox, { theme, compact: true, onSelect: () => undefined })); });
    await answer("fleet.findings.list", ok({ findings, skipped: 0 }));
  };

  it("defaults to all repos, filters to the chosen repos, and remembers the choice across remounts", async () => {
    await mount();
    expect(rows()).toHaveLength(3);
    expect(chip("All repos").props["accessibilityState"]).toMatchObject({ selected: true });
    await press("alpha");
    await press("gamma");
    expect(rows().map((r) => r.props["accessibilityLabel"] as string).every((l) => !l.includes("beta"))).toBe(true);
    expect(rows()).toHaveLength(2);
    await act(async () => root!.unmount());
    await mount();
    expect(rows()).toHaveLength(2);
    await press("All repos");
    expect(rows()).toHaveLength(3);
  });

  it("keeps a remembered repo that is temporarily absent when another chip is toggled", async () => {
    repoSelection.set(["alpha", "delta"]); // delta has no findings right now
    await mount();
    await press("gamma");
    expect(repoSelection.get()).toEqual(["alpha", "delta", "gamma"]);
    await press("alpha");
    expect(repoSelection.get()).toEqual(["delta", "gamma"]);
    repoSelection.set([]);
  });
});

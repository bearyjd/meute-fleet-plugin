// Settings optimistic concurrency (review 06 paseo F4) and recovery from an invalid document (F5).
import { createElement, type ReactNode } from "react";
import TestRenderer, { act, type Renderer, type TestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

interface Save { values: Record<string, string>; revision: string }
const h = vi.hoisted(() => ({ state: null as unknown, saves: [] as Save[], resets: 0, reloads: 0 }));
vi.mock("react-native", () => ({ Text: (p: { children?: ReactNode }) => createElement("Text", p, p.children) }));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsSection: (p: { children?: ReactNode }) => createElement("Section", null, p.children),
  SettingsCard: (p: { children?: ReactNode }) => createElement("Card", null, p.children),
  SettingsInput: (p: object) => createElement("Input", p),
  SettingsAction: (p: object) => createElement("Action", p),
}));
vi.mock("@getpaseo/plugin/client", () => ({ useSettings: () => h.state }));
import { FleetSettings } from "../client/settings-screen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const base = { meutePath: "/a/bin/meute", meuteRoot: "/a", readinessRecordPath: "", readinessPolicyPath: "", runnerPath: "", xdgRuntimeDir: "" };
const common = {
  saving: false, saveError: null,
  // Like the host's PluginSettingsStore: a save against any revision but the stored one is a conflict.
  save: async (values: Record<string, string>, revision: string) => {
    h.saves.push({ values, revision });
    return revision === (h.state as { revision?: string }).revision;
  },
  reset: async () => { h.resets += 1; return true; },
  reload: async () => { h.reloads += 1; },
};
const ready = (values: typeof base, revision: string) => ({ status: "ready", values, revision, ...common });
const theme = { colors: { foregroundMuted: "#888", statusWarning: "#f80" } } as never;
const screen = () => createElement(FleetSettings, { theme } as never);

const find = (r: Renderer, type: string) => r.root.findAll((n: TestInstance) => n.type === type);
const action = (r: Renderer, label: string) => find(r, "Action").find((n) => n.props["actionLabel"] === label);
const press = async (node: TestInstance | undefined) => {
  expect(node).toBeDefined();
  await act(async () => { await (node!.props["onPress"] as () => unknown)(); });
};
const type = async (r: Renderer, label: string, text: string) => {
  const input = find(r, "Input").find((n) => String(n.props["label"]).startsWith(label));
  await act(async () => (input!.props["onChangeText"] as (t: string) => void)(text));
};

describe("settings screen", () => {
  it("saves against the revision the draft started from, so another client's change is a conflict", async () => {
    h.saves = [];
    h.state = ready(base, "rev1");
    let r!: Renderer;
    await act(async () => { r = TestRenderer.create(screen()); });
    await type(r, "XDG_RUNTIME_DIR", "/run/user/7");
    h.state = ready({ ...base, meutePath: "/b/bin/meute", meuteRoot: "/b" }, "rev2"); // client B saved
    await act(async () => r.update(screen()));
    expect(find(r, "Text").some((n) => /changed on another client/i.test([n.props["children"]].flat().join("")))).toBe(true);
    await press(action(r, "Save"));
    expect(h.saves[0]?.revision).toBe("rev1"); // the host rejects a stale base revision
    await press(action(r, "Reload"));
    expect(find(r, "Input").find((n) => n.props["label"] === "MEUTE_ROOT")?.props["initialValue"]).toBe("/b");
    await press(action(r, "Save"));
    expect(h.saves[1]).toMatchObject({ revision: "rev2", values: { meuteRoot: "/b" } });
    r.unmount();
  });

  it("after its own successful save, the form adopts the new revision (no self-conflict)", async () => {
    h.saves = [];
    h.state = ready(base, "rev1");
    let r!: Renderer;
    await act(async () => { r = TestRenderer.create(screen()); });
    await type(r, "XDG_RUNTIME_DIR", "/run/user/7");
    await press(action(r, "Save"));
    h.state = ready({ ...base, xdgRuntimeDir: "/run/user/7" }, "rev2"); // the push for our own save
    await act(async () => r.update(screen()));
    expect(find(r, "Text").some((n) => /changed on another client/i.test([n.props["children"]].flat().join("")))).toBe(false);
    await press(action(r, "Save"));
    expect(h.saves.map((s) => s.revision)).toEqual(["rev1", "rev2"]);
    r.unmount();
  });

  it("N8: a no-op Save does not disarm conflict detection: another client's later save is a conflict", async () => {
    h.saves = [];
    h.state = ready(base, "rev1");
    let r!: Renderer;
    await act(async () => { r = TestRenderer.create(screen()); });
    await press(action(r, "Save")); // nothing edited: the host keeps revision rev1
    await act(async () => r.update(screen()));
    h.state = ready({ ...base, meutePath: "/b/bin/meute", meuteRoot: "/b" }, "rev2"); // client B saved
    await act(async () => r.update(screen()));
    expect(find(r, "Text").some((n) => /changed on another client/i.test([n.props["children"]].flat().join("")))).toBe(true);
    await type(r, "XDG_RUNTIME_DIR", "/run/user/7");
    await press(action(r, "Save"));
    expect(h.saves.map((save) => save.revision)).toEqual(["rev1", "rev1"]); // rejected, B's change survives
    r.unmount();
  });

  it("an invalid stored document offers Reset as well as Reload", async () => {
    h.resets = 0;
    h.state = { status: "invalid", error: "Settings version 2 requires a migration", revision: "r", ...common };
    let r!: Renderer;
    await act(async () => { r = TestRenderer.create(screen()); });
    expect(find(r, "Action").map((n) => n.props["actionLabel"]).sort()).toEqual(["Reload", "Reset"]);
    await press(action(r, "Reset"));
    expect(h.resets).toBe(1);
    r.unmount();
  });

  it("a transport error offers Reload only", async () => {
    h.state = { status: "error", error: "offline", ...common };
    let r!: Renderer;
    await act(async () => { r = TestRenderer.create(screen()); });
    expect(find(r, "Action").map((n) => n.props["actionLabel"])).toEqual(["Reload"]);
    r.unmount();
  });
});

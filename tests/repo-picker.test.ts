// Repo picker: pure selection logic and the client-side store. Repo names are untrusted text.
import { afterEach, describe, expect, it } from "vitest";
import { createRepoSelectionStore } from "../client/repo-selection";
import {
  effectiveRepos, filterFindings, parseStoredRepos, pickerRepos, toggleRepo, type Filters,
} from "../client/viewmodel";
import type { Finding } from "../shared/contracts";

const f = (id: string, repo: string): Finding => ({
  id, report: "r", n: 1, repo, severity: "LOW", title: "t", location: "", state: "new", inherited: "", verdict: "", pr: "",
});
const ALL: Filters = { state: "all", repo: "", severity: "" };
const list = [f("a/x#1", "a"), f("b/x#1", "b"), f("c/x#1", "c")];

describe("repo selection logic", () => {
  it("empty selection means all repos; several repos are a union", () => {
    const ids = (repos: string[]) => filterFindings(list, { ...ALL, repos }).map((x) => x.id);
    expect(ids([])).toEqual(["a/x#1", "b/x#1", "c/x#1"]);
    expect(ids(["a"])).toEqual(["a/x#1"]);
    expect(ids(["a", "c"])).toEqual(["a/x#1", "c/x#1"]);
  });

  it("toggleRepo adds, removes and never mutates", () => {
    const start = ["a"] as const;
    expect(toggleRepo(start, "b")).toEqual(["a", "b"]);
    expect(toggleRepo(["a", "b"], "a")).toEqual(["b"]);
    expect(start).toEqual(["a"]);
  });

  it("effectiveRepos drops repos that no longer exist, falling back to all", () => {
    expect(effectiveRepos(["a", "gone"], ["a", "b"])).toEqual(["a"]);
    expect(effectiveRepos(["gone"], ["a", "b"])).toEqual([]);
    expect(effectiveRepos(["a"], [])).toEqual([]);
  });

  it("pickerRepos lists each safe repo name once, sorted, and skips unsafe names", () => {
    const names = ["b", "a", "b", "../etc", "x/y", "ok.repo-1", "bad‮name", ""];
    expect(pickerRepos(names.map((repo) => f(`${repo}/x#1`, repo)))).toEqual(["a", "b", "ok.repo-1"]);
  });

  it("parseStoredRepos accepts only a JSON array of safe, unique names", () => {
    expect(parseStoredRepos('["b","a","a"]')).toEqual(["a", "b"]);
    expect(parseStoredRepos(null)).toEqual([]);
    expect(parseStoredRepos("not json")).toEqual([]);
    expect(parseStoredRepos('{"a":1}')).toEqual([]);
    expect(parseStoredRepos('["a","../x",5,"b\\u202e"]')).toEqual(["a"]);
    expect(parseStoredRepos(JSON.stringify(Array.from({ length: 500 }, (_, i) => `r${i}`)))).toHaveLength(64);
    expect(parseStoredRepos("x".repeat(100_000))).toEqual([]);
  });
});

describe("repo selection store", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };
  afterEach(() => undefined);

  it("defaults to all repos and persists through the storage it is given", () => {
    const storage = memory();
    const store = createRepoSelectionStore(storage);
    expect(store.get()).toEqual([]);
    store.set(["b", "a"]);
    expect(store.get()).toEqual(["b", "a"]);
    expect(createRepoSelectionStore(storage).get()).toEqual(["a", "b"]);
  });

  it("works with no storage (memory only) and survives a storage that throws", () => {
    const none = createRepoSelectionStore(undefined);
    none.set(["a"]);
    expect(none.get()).toEqual(["a"]);
    const broken = createRepoSelectionStore({ getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } });
    expect(broken.get()).toEqual([]);
    broken.set(["a"]);
    expect(broken.get()).toEqual(["a"]);
  });

  it("only ever stores validated names and notifies subscribers", () => {
    const storage = memory();
    const store = createRepoSelectionStore(storage);
    const seen: string[][] = [];
    const off = store.subscribe(() => seen.push([...store.get()]));
    store.set(["a", "../evil"]);
    expect(store.get()).toEqual(["a"]);
    expect(storage.data.get("meute-fleet.repos")).toBe('["a"]');
    off();
    store.set([]);
    expect(seen).toEqual([["a"]]);
  });
});

import { describe, expect, it } from "vitest";
import { validateDraft } from "../client/settings-form";
import { fleetSettings } from "../shared/settings";
import {
  isSafeAbsolutePath, isSafeName, isSafePathList, parseFindingId, redactPaths, sanitizeText,
} from "../shared/validate";

describe("parseFindingId", () => {
  it("parses repo/name#n", () => {
    expect(parseFindingId("sample/audit-2026-11-20#2")).toEqual({ repo: "sample", name: "audit-2026-11-20", n: 2 });
  });
  it.each(["", "a", "a/b", "a/b#", "a/b#0", "a/b#-1", "a/b#01", "a/b#10000", "a/b#1x", "a//b#1", "../b#1", "a/..#1",
    "a/b/c#1", " a/b#1", "a/b#1 ", "a/b#1\n", "a/b\0#1", "a/é#1", "-a/b#1", ".a/b#1", "a/b#９", "a;b/c#1", "a/b#1;rm",
    `${"a".repeat(200)}/b#1`, "a/b..c#1"])("rejects %j", (id) => expect(parseFindingId(id)).toBeNull());
  it("rejects non-strings", () => {
    for (const v of [undefined, null, 5, {}, ["a/b#1"]]) expect(parseFindingId(v)).toBeNull();
  });
  it("isSafeName accepts exactly [A-Za-z0-9][A-Za-z0-9._-]*", () => {
    for (const n of ["a", "A-b_c.d", "v1.2", "0"]) expect(isSafeName(n)).toBe(true);
    for (const n of ["a+b", "a~b", "a@b", "a%b", "-a", "_a", "é", "a\u2024b"]) expect(isSafeName(n)).toBe(false);
  });

  it("sanitizeText strips bidi isolates U+2066-U+2069 as well as overrides", () => {
    expect(sanitizeText("a\u2066b\u2067c\u2068d\u2069e\u202ef")).toBe("abcdef");
  });

  it("isSafeName rejects dots and separators", () => {
    for (const n of [".", "..", "", "a/b", "a\\b", ".hidden", "a b"]) expect(isSafeName(n)).toBe(false);
    expect(isSafeName("audit-2026.11_20")).toBe(true);
  });
});

describe("path validators", () => {
  it("accepts clean absolute paths, including spaces", () => {
    for (const p of ["/a", "/a/b c/d.json", "/srv/meute"]) expect(isSafeAbsolutePath(p)).toBe(true);
  });
  it.each(["", "/", "a", "./a", "/a/", "/a//b", "/a/./b", "/a/../b", "/a\0b", "/a\nb", "/a\tb", "/a\u007fb"])("rejects %j", (p) =>
    expect(isSafeAbsolutePath(p)).toBe(false));
  it("PATH lists", () => {
    expect(isSafePathList("/usr/bin:/bin")).toBe(true);
    for (const p of ["usr/bin", "/usr/bin::/bin", "/usr/bin:", "/a/../b"]) expect(isSafePathList(p)).toBe(false);
  });
});

describe("text safety", () => {
  it("strips escapes, controls and bidi overrides, normalises newlines", () => {
    expect(sanitizeText("a\u001b[31mb\u001b[0m\u0007c\r\nd‮e")).toBe("abc\nde");
  });
  it("caps length", () => expect(sanitizeText("x".repeat(100), 10)).toBe(`${"x".repeat(10)}…`));
  it("redacts absolute paths and known roots", () => {
    expect(redactPaths("cannot read /home/op/secret/file.json now")).toBe("cannot read <path> now");
    expect(redactPaths("in /srv/meute root now", ["/srv/meute root"])).toBe("in <path> now");
    expect(redactPaths("value a/b stays")).toBe("value a/b stays");
  });
});

describe("settings", () => {
  it("has no defaults that point anywhere", () => {
    expect(fleetSettings.schema.parse({})).toEqual({
      meutePath: "", meuteRoot: "", readinessRecordPath: "", readinessPolicyPath: "", runnerPath: "", xdgRuntimeDir: "",
    });
  });
  it("schema rejects relative and traversal paths", () => {
    expect(fleetSettings.schema.safeParse({ meutePath: "bin/meute" }).success).toBe(false);
    expect(fleetSettings.schema.safeParse({ meuteRoot: "/a/../b" }).success).toBe(false);
    expect(fleetSettings.schema.safeParse({ runnerPath: "usr/bin" }).success).toBe(false);
  });
  it("the form validator mirrors the schema and the <root>/bin/meute rule", () => {
    const base = fleetSettings.schema.parse({});
    expect(validateDraft(base)).toEqual({});
    expect(validateDraft({ ...base, meuteRoot: "/m", meutePath: "/m/bin/meute" })).toEqual({});
    expect(validateDraft({ ...base, meuteRoot: "/m", meutePath: "/x/meute" })).toHaveProperty("meutePath");
    expect(validateDraft({ ...base, xdgRuntimeDir: "rel" })).toHaveProperty("xdgRuntimeDir");
  });
});

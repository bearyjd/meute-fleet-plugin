// With realpath reduced to the identity, the descriptor-level walk alone must refuse every link
// (review 06 tests S1: O_NOFOLLOW had no test that needed it; files F2: per-component walk).
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readReportFile } from "../server/safefs";
import { makeSandbox, type Sandbox } from "./helpers";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return { ...real, realpath: async (path: string) => String(path) };
});

let box: Sandbox | undefined;
afterEach(() => {
  box?.cleanup();
  box = undefined;
});

describe("descriptor walk without realpath", () => {
  it("refuses a symlinked report file", async () => {
    box = makeSandbox("true");
    mkdirSync(join(box.root, "reports/r"));
    writeFileSync(join(box.dir, "secret.md"), "### [LOW] SECRET\n");
    symlinkSync(join(box.dir, "secret.md"), join(box.root, "reports/r/x.md"));
    expect(await readReportFile(box.root, "r", "x")).toMatchObject({ ok: false, code: "unsafe_path", message: expect.stringMatching(/symbolic link/) });
  });

  it("refuses a symlinked parent directory", async () => {
    box = makeSandbox("true");
    mkdirSync(join(box.dir, "outside"));
    writeFileSync(join(box.dir, "outside/x.md"), "### [LOW] SECRET\n");
    symlinkSync(join(box.dir, "outside"), join(box.root, "reports/r"));
    expect(await readReportFile(box.root, "r", "x")).toMatchObject({ ok: false, code: "unsafe_path", message: expect.stringMatching(/symbolic link/) });
  });

  it("refuses a symlinked reports/ directory", async () => {
    box = makeSandbox("true");
    mkdirSync(join(box.dir, "outside/r"), { recursive: true });
    writeFileSync(join(box.dir, "outside/r/x.md"), "### [LOW] SECRET\n");
    const { rmSync } = await import("node:fs");
    rmSync(join(box.root, "reports"), { recursive: true });
    symlinkSync(join(box.dir, "outside"), join(box.root, "reports"));
    expect(await readReportFile(box.root, "r", "x")).toMatchObject({ ok: false, code: "unsafe_path", message: expect.stringMatching(/symbolic link/) });
  });

  it("still reads a plain file", async () => {
    box = makeSandbox("true");
    mkdirSync(join(box.root, "reports/r"));
    writeFileSync(join(box.root, "reports/r/x.md"), "### [LOW] fine\n");
    expect(await readReportFile(box.root, "r", "x")).toMatchObject({ ok: true, text: "### [LOW] fine\n" });
  });
});

// The last line of defence: a directory moved out of the root WHILE the walk holds it. The move
// is made deterministic by doing it right after the walk opened reports/r.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeSandbox } from "./helpers";

const hook = vi.hoisted(() => ({ onOpen: null as null | ((path: string) => void) }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      hook.onOpen?.(String(args[0]));
      return handle;
    },
  };
});
import { readReportFile } from "../server/safefs";

describe("a directory moved out of the root mid-walk", () => {
  it("is refused: the opened file must still resolve inside the root", async () => {
    const box = makeSandbox("true");
    try {
      mkdirSync(join(box.root, "reports/r"));
      writeFileSync(join(box.root, "reports/r/x.md"), "### [LOW] moved\n");
      mkdirSync(join(box.dir, "outside"));
      hook.onOpen = (path) => {
        if (path.endsWith("/r")) {
          hook.onOpen = null;
          renameSync(join(box.root, "reports/r"), join(box.dir, "outside/r"));
        }
      };
      expect(await readReportFile(box.root, "r", "x")).toMatchObject({
        ok: false, code: "unsafe_path", message: expect.stringMatching(/no longer inside/),
      });
    } finally {
      hook.onOpen = null;
      box.cleanup();
    }
  });
});

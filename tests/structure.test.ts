import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import contribute from "../index.server";
import { ALL_RPCS } from "../shared/contracts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      // Dot-dirs (.git, .test-tmp: the default FLEET_TEST_TMPDIR, whose sandboxes come and go) are not sources.
      if (["node_modules", "tests"].includes(name) || name.startsWith(".")) continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && !/^(vitest|eslint)\.config/.test(name)) out.push(path);
    }
  };
  walk(ROOT);
  return out;
}
const text = (path: string) => readFileSync(path, "utf8");
const rel = (path: string) => relative(ROOT, path);

describe("process spawning is confined to server/runner.ts", () => {
  it("only the runner touches child_process", () => {
    const offenders = sources().filter((p) => /child_process|node:cluster|worker_threads/.test(text(p))).map(rel);
    expect(offenders).toEqual(["server/runner.ts"]);
  });

  it("the runner never uses a shell or the exec family", () => {
    const runner = text(join(ROOT, "server/runner.ts")).replace(/\/\/.*$/gm, "");
    expect(runner).toMatch(/shell: false/);
    expect(runner).not.toMatch(/shell:\s*true|\bexec\(|execSync|spawnSync|execFileSync|\bfork\(/);
    expect(runner).not.toMatch(/process\s*(\.|\[)\s*["'`]?env/);
  });

  it("nothing else reads the daemon environment", () => {
    const offenders = sources().filter((p) => /process\s*(\.|\[)\s*["'`]?env/.test(text(p))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("no module outside safefs.ts opens files", () => {
    const offenders = sources().filter((p) => /node:fs/.test(text(p))).map(rel).sort();
    expect(offenders).toEqual(["server/config.ts", "server/safefs.ts", "server/session.ts", "server/tree.ts"]);
    // session.ts creates exactly one thing, the child's private HOME (mkdtemp), and removes only
    // the HOMEs it made (rm/rmdir in discard, removePrivateHomes and the refused-HOME path).
    const session = text(join(ROOT, "server/session.ts"));
    expect(session).not.toMatch(/writeFile|appendFile|mkdir\(|unlink|rename|chmod|open\(/);
    expect(session.match(/\b(rm|rmdir|rmSync)\(/g)).toEqual(["rm(", "rmdir(", "rmdir(", "rmSync("]);
    for (const inspector of ["server/config.ts", "server/tree.ts"]) {
      expect(text(join(ROOT, inspector))).not.toMatch(/writeFile|appendFile|mkdir|unlink|rename|rm\(|chmod|open\(/);
    }
    expect(text(join(ROOT, "server/safefs.ts"))).not.toMatch(/writeFile|appendFile|mkdir|unlink|rename|\brm\(|chmod|O_WRONLY|O_RDWR|O_CREAT|O_APPEND|O_TRUNC/);
  });
});

describe("the client never renders report content as markup", () => {
  const client = sources().filter((p) => rel(p).startsWith("client/") || rel(p) === "index.client.tsx");

  it("has client sources", () => expect(client.length).toBeGreaterThan(2));

  it("does not import Markdown, frames, links or web views, nor set raw HTML", () => {
    for (const path of client) {
      const code = text(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, rel(path)).not.toMatch(/\bMarkdown\b|DocumentFrame|ExternalLink|WebView|dangerouslySetInnerHTML|innerHTML|openExternalUrl|StreamedText|Linking/);
    }
  });

  it("does not import Node modules or the SDK server entry", () => {
    for (const path of client) expect(text(path), rel(path)).not.toMatch(/from "node:|@getpaseo\/plugin\/server|child_process/);
  });
});

describe("plugin registration", () => {
  it("registers settings and exactly the five read RPCs, nothing else", () => {
    const handled: string[] = [];
    const calls: string[] = [];
    const server = new Proxy({}, {
      get: (_target, prop: string) => {
        calls.push(prop);
        if (prop === "registerSettings") return () => ({ read: async () => ({ status: "invalid" }), subscribe: () => () => {} });
        if (prop === "handle") return (contract: { name: string }) => handled.push(contract.name);
        throw new Error(`unexpected server API: ${prop}`);
      },
    });
    const cleanup = contribute(server as never);
    expect(typeof cleanup).toBe("function");
    expect(handled.sort()).toEqual(["fleet.finding.get", "fleet.findings.list", "fleet.health.get", "fleet.readiness.get", "fleet.run.status"]);
    expect(handled.sort()).toEqual(ALL_RPCS.map((rpc) => rpc.name).sort());
    expect(new Set(calls)).toEqual(new Set(["registerSettings", "handle"]));
  });

  it("RPC names do not suggest writes", () => {
    for (const rpc of ALL_RPCS) expect(rpc.name).not.toMatch(/resolve|dismiss|promote|claim|run\.(start|stop)|enqueue|receipt|decision|write|set\b/);
  });

  it("every handler answers with an envelope instead of throwing when settings are invalid", async () => {
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    const server = {
      registerSettings: () => ({ read: async () => ({ status: "invalid", revision: "1", error: "x" }), subscribe: () => () => {} }),
      handle: (contract: { name: string }, handler: (input: unknown) => Promise<unknown>) => handlers.set(contract.name, handler),
    };
    contribute(server as never);
    for (const [name, handler] of handlers) {
      const result = await handler({ id: "a/b#1", lines: 5 });
      expect(result, name).toMatchObject({ ok: false, error: { code: "invalid_config" } });
    }
  });

  it("a settings read that throws is an internal envelope, not a crash", async () => {
    const handlers: Array<(input: unknown) => Promise<unknown>> = [];
    const server = {
      registerSettings: () => ({ read: async () => { throw new Error("boom /secret/path"); }, subscribe: () => () => {} }),
      handle: (_c: unknown, handler: (input: unknown) => Promise<unknown>) => handlers.push(handler),
    };
    contribute(server as never);
    const result = await handlers[0]?.({});
    expect(result).toMatchObject({ ok: false, error: { code: "internal", message: "Unexpected error" } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

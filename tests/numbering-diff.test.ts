// Finding numbering must match meute exactly (review 06 files F1): `repo/name#n` is meute's id,
// so the excerpt shown for #n must be the text meute has under #n. Differential test against
// meute's own Python regex on a hostile corpus plus a seeded fuzz corpus.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getFinding } from "../server/fleet";
import { extractFindingExcerpt, MAX_EXCERPT_CHARS } from "../server/parsers";
import { sanitizeText } from "../shared/validate";
import { FIXTURES, makeFixtureRoot, realMeuteSource } from "./helpers";

type Oracle = { error: true } | { findings: Array<{ severity: string; title: string; chunk: string }> };

const work = realpathSync(mkdtempSync(join(tmpdir(), "fleet-numbering-")));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Runs the oracle once for a batch. Uses a COPY of meute's report.py when MEUTE_SOURCE_DIR is set. */
function oracle(docs: readonly Buffer[]): Oracle[] {
  const real = realMeuteSource();
  let libDir = "";
  if ("source" in real) {
    libDir = join(work, "lib");
    mkdirSync(libDir, { recursive: true });
    cpSync(join(real.source, "lib/report.py"), join(libDir, "report.py"));
  }
  const run = spawnSync("python3", ["-I", "-B", join(FIXTURES, "python/numbering.py"), libDir], {
    input: JSON.stringify(docs.map((doc) => doc.toString("base64"))),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`oracle failed: ${run.stderr}`);
  return JSON.parse(run.stdout) as Oracle[];
}

const HOSTILE: readonly string[] = [
  "note ### [LOW] injected\n### [MEDIUM] two",
  "### [HIGH] one\n### [LOW] nbsp\n### [MEDIUM] two",
  "### [HIGH] one\n###\n[LOW] split\n### [MEDIUM] two",
  "### [LOW]\n### [HIGH] two",
  "### [LOW] a ### [HIGH] b ### [MEDIUM] c",
  "﻿### [LOW] bom\n### [HIGH] two",
  "---\nrepo: x\n---\n### [LOW] after front matter\n### [HIGH] b",
  "### [LOW] a\r\n### [HIGH] b\r### [MEDIUM] c",
  "### [LOW] a\nbody\n## Next section\n### [HIGH] b\n## Tail\nmore",
  "### [LOW] title \u0085 nel\n### [HIGH] b",
  "###　[LOW] ideographic\n###\u001c[HIGH] file separator\n###\u000b[MEDIUM] vt",
  "### [LOW]   \n\n  \n### [HIGH] x",
  "### [LOW] a\n ## not a section in python\n### [HIGH] b",
  "### [low] lower\n#### [LOW] four\n ### [LOW] indented\n###[LOW] tight\n### [LOW] real",
  "### [LOW] trailing  　 \n### [CRITICAL] title",
];

/** Byte sequences meute refuses (strict UTF-8). */
const INVALID: readonly Buffer[] = [
  Buffer.concat([Buffer.from("### [LOW] bad "), Buffer.from([0xff]), Buffer.from("\n")]),
  Buffer.concat([Buffer.from("### [LOW] overlong "), Buffer.from([0xc0, 0xaf])]),
  Buffer.concat([Buffer.from("### [LOW] surrogate "), Buffer.from([0xed, 0xa0, 0x80])]),
  Buffer.concat([Buffer.from("### [LOW] cut "), Buffer.from([0xe2, 0x82])]),
];

function fuzzCorpus(count: number, seed: number): string[] {
  const tokens = ["###", " ", "\t", "\n", "\r", "\r\n", " ", " ", " ", "\u0085", "\u000b", "\u000c",
    "\u001c", "\u001f", "　", " ", "﻿", "​", "[LOW]", "[HIGH]", "[CRITICAL]", "[MEDIUM]", "[low]",
    "x", "title", "## ", "---\n", "\n---\n", "#", "]", "["];
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: 4 + Math.floor(next() * 40) }, () => tokens[Math.floor(next() * tokens.length)]).join(""));
}

function compare(doc: string, expected: Oracle): void {
  if ("error" in expected) throw new Error("valid string reported invalid by the oracle");
  const label = JSON.stringify(doc);
  expected.findings.forEach((finding, index) => {
    const got = extractFindingExcerpt(doc, index + 1);
    const excerpt = sanitizeText(finding.chunk.trimEnd(), Number.MAX_SAFE_INTEGER).slice(0, MAX_EXCERPT_CHARS);
    expect(got, `${label} #${index + 1}`).toEqual({
      ok: true,
      data: { id: "", severity: finding.severity, title: sanitizeText(finding.title, 300), excerpt, truncated: false },
    });
  });
  expect(extractFindingExcerpt(doc, expected.findings.length + 1), `${label} #${expected.findings.length + 1}`)
    .toMatchObject({ ok: false, error: { code: "not_found" } });
}

describe("finding numbering matches meute's lib/report.py", () => {
  it("hostile corpus", () => {
    const answers = oracle(HOSTILE.map((doc) => Buffer.from(doc, "utf8")));
    HOSTILE.forEach((doc, index) => compare(doc, answers[index]!));
  });

  it("seeded fuzz corpus (3000 documents)", () => {
    const docs = fuzzCorpus(3000, 20261125);
    const answers = oracle(docs.map((doc) => Buffer.from(doc, "utf8")));
    docs.forEach((doc, index) => compare(doc, answers[index]!));
  });

  it("invalid UTF-8 is refused like meute does (report unavailable), valid BOM text is not", async () => {
    const answers = oracle([...INVALID, Buffer.from("﻿### [LOW] bom", "utf8")]);
    expect(answers.slice(0, INVALID.length).every((answer) => "error" in answer)).toBe(true);
    // Python keeps the BOM, so "\ufeff###" is not a heading there either.
    expect(answers[INVALID.length]).toEqual({ findings: [] });
    const box = makeFixtureRoot();
    try {
      for (const [index, bytes] of INVALID.entries()) {
        writeFileSync(join(box.root, "reports/sample", `bad-${index}.md`), bytes);
        expect(await getFinding(box.config, { id: `sample/bad-${index}#1` })).toMatchObject({ ok: false, error: { code: "unavailable" } });
      }
      writeFileSync(join(box.root, "reports/sample/bom.md"), "﻿### [LOW] bom\n### [HIGH] two\n");
      expect(await getFinding(box.config, { id: "sample/bom#1" })).toMatchObject({ ok: true, data: { title: "two" } });
    } finally {
      box.cleanup();
    }
  });
});

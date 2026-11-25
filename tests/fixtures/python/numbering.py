"""Differential oracle for finding numbering: meute's own regex and finding_body logic.

argv[1]: a directory holding a COPY of meute's lib/report.py, or "" to use the pinned regex.
stdin: JSON list of base64 documents. stdout: JSON list, one entry per document:
  {"error": true} when meute's strict UTF-8 decode refuses it, else
  {"findings": [{"severity", "title", "chunk"}]} with chunk as inbox.finding_body returns it.
Run with python3 -I -B so neither PYTHONPATH, user site nor __pycache__ is involved.
"""
import base64, json, re, sys

FINDING_RE = re.compile(r"^###\s+\[(CRITICAL|HIGH|MEDIUM|LOW)\]\s*(.*)$", re.M)
if sys.argv[1]:
    sys.path.insert(0, sys.argv[1])
    import report as report_lib  # the copied meute module
    assert report_lib.FINDING_RE.pattern == FINDING_RE.pattern and report_lib.FINDING_RE.flags == FINDING_RE.flags
    FINDING_RE = report_lib.FINDING_RE
    split_report = report_lib.split_report
else:
    def split_report(text):
        body = text
        if text.startswith("---\n"):
            end = text.find("\n---\n", 4)
            if end != -1:
                body = text[end + 5:]
        return {}, body

def finding_body(body, heads, n):
    start = heads[n - 1].start()
    end = heads[n].start() if n < len(heads) else len(body)
    chunk = body[start:end]
    first_nl = chunk.find("\n")
    nxt = re.search(r"^## ", chunk[first_nl + 1:], re.M) if first_nl >= 0 else None
    return chunk[: first_nl + 1 + nxt.start()] if nxt else chunk

out = []
for encoded in json.load(sys.stdin):
    data = base64.b64decode(encoded)
    try:
        text = data.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
    except UnicodeDecodeError:
        out.append({"error": True})
        continue
    _, body = split_report(text)
    heads = list(FINDING_RE.finditer(body))
    out.append({"findings": [
        {"severity": m.group(1), "title": m.group(2).strip(), "chunk": finding_body(body, heads, i + 1)}
        for i, m in enumerate(heads)
    ]})
json.dump(out, sys.stdout)

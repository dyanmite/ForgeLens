// Headless rehearsal of Task A: same prompt shape as the extension's inline edit.
// usage: node scripts/dev-inline.cjs <repo> <file> <symbol> "<instruction>" [models]
const fs = require("fs");
const path = require("path");
const core = require("../dist/core.js");
const [repo, file, symbol, instruction, modelsArg] = process.argv.slice(2);
const models = (modelsArg || "google-gemini/gemini-3-5-flash,google-gemini/gemini-3-5-flash-lite,groq/openai-gpt-oss-120b").split(",");
(async () => {
  const text = fs.readFileSync(path.join(repo, file), "utf8").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const sym = core.parsePythonSymbols(file, lines).find((s) => s.name === symbol);
  const sel = lines.slice(sym.line - 1, sym.endLine);
  const before = lines.slice(Math.max(0, sym.line - 61), sym.line - 1);
  const after = lines.slice(sym.endLine, sym.endLine + 40);
  const input = [
    `File: ${file} (python)`, `Instruction: ${instruction}`, "",
    "Code BEFORE the selection (context only, do not output):\n```python\n" + before.join("\n") + "\n```",
    `SELECTION (lines ${sym.line}-${sym.endLine}) — rewrite this:\n\`\`\`python\n${sel.join("\n")}\n\`\`\``,
    "Code AFTER the selection (context only, do not output):\n```python\n" + after.join("\n") + "\n```", "",
    "Return only the rewritten SELECTION in one fenced code block.",
  ].join("\n");
  const fc = new core.ForgeClient("http://localhost:8790", path.join(__dirname, "..", "agents"));
  const t0 = Date.now();
  let first = 0;
  const res = await fc.run({ kind: "inline", models, input, retries: 2, signal: new AbortController().signal, cb: {
    onStatus: (s) => console.log(`[status] ${s.phase} ${s.model} ${s.message ?? ""}`),
    onDelta: (_t, _id, c, k) => { if (k === "content" && !first) first = Date.now() - t0; },
  } });
  console.log(`[result] ${res.status} ${res.model} first-token ${first}ms total ${Date.now() - t0}ms fellBack=${res.fellBack}`);
  const m = /```[\w+-]*[^\n]*\n([\s\S]*?)```/.exec(res.output);
  const code = m ? m[1].replace(/\n+$/, "") : res.output;
  const segs = core.computeSegments(sel.join("\n") + "\n", code + "\n");
  console.log(`hunks: ${core.hunksOf(segs).length}`);
  console.log(code);
})();

// Headless end-to-end harness: real TrueForge + real model + ForgeLens MCP tools,
// with every hunk auto-accepted. Used to tune prompts/retrieval without VS Code.
// usage: node scripts/dev-agent.cjs <repoCopy> <agent|inline> "<request>" [model,model2]
const fs = require("fs");
const path = require("path");
const core = require("../dist/core.js");

const [repo, kind, request, modelsArg] = process.argv.slice(2);
const models = (modelsArg || "google-gemini/gemini-3-5-flash,groq/openai-gpt-oss-120b").split(",");
const root = path.resolve(repo);

(async () => {
  const index = new core.RepoIndex(root).build();
  const readFile = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      return undefined;
    }
  };
  const book = new core.ApprovalBook();
  const py = core.pythonFor(root);
  const host = {
    root,
    index,
    readFile,
    async applyApprovedEdit(tool, args) {
      const r = core.finalizeApprovedEdit(book, readFile, tool, args);
      fs.mkdirSync(path.dirname(path.join(root, r.rel)), { recursive: true });
      fs.writeFileSync(path.join(root, r.rel), r.after);
      index.update(r.rel);
      return r.message;
    },
    async runApprovedCommand(args) {
      const r = await core.runCommand(root, args.command);
      return `$ ${args.command}\nexit code: ${r.exitCode}${r.timedOut ? " (timed out)" : ""}\n${r.output}`;
    },
    onActivity(a) {
      console.log(`   [tool] ${a.tool} ${a.path ?? ""} ${a.lines ? a.lines.join("-") : ""} — ${String(a.summary).slice(0, 140)}`);
    },
  };
  const mcp = await core.startMcpHttp(host, 0, console.error);
  const fc = new core.ForgeClient("http://localhost:8790", path.join(__dirname, "..", "agents"));
  await fc.registerConnector(mcp.url, mcp.token);
  console.log("MCP at", mcp.url);

  let input = request;
  if (kind === "agent") {
    const pack = core.buildContextPack(index, request, 6000);
    console.log(`context pack: ${pack.ledger.filter((l) => l.included).length} snippets, ${pack.used}/${pack.budget} tokens`);
    input = `${request}\n\n${pack.text}`;
  }
  const t0 = Date.now();
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  let last = "";
  const res = await fc.run({
    kind,
    models,
    input,
    retries: 2,
    signal: ac.signal,
    title: "dev harness",
    cb: {
      onStatus: (s) => console.log(`[status] ${s.phase} ${s.model} ${s.message ?? ""} ${s.sessionId ?? ""}`),
      onDelta: (t, id, chunk, k) => {
        if (k === "content") {
          if (id !== last) process.stdout.write(`\n[${t}] `);
          last = id;
          process.stdout.write(chunk);
        }
      },
      onToolCall: (t, c) => console.log(`\n[${t}] → ${c.tool}(${JSON.stringify(c.args).slice(0, 160)})`),
      onThread: (t, title, phase, d) => console.log(`[thread] ${phase} ${t} ${title} ${d ? String(d).slice(0, 200) : ""}`),
      onCompaction: (t, p) => console.log(`[compaction] ${p} ${t}`),
      onApproval: async (calls) => {
        const out = [];
        for (const c of calls) {
          if (c.tool === "run_command") {
            console.log(`[approve] run_command ${c.args.command}`);
            out.push({ toolCallId: c.toolCallId, threadId: c.threadId, allow: true });
            continue;
          }
          try {
            const rv = core.prepareProposal(root, index, readFile, c.tool, c.args, py);
            book.record(rv, new Set(rv.hunks.map((h) => h.index)));
            console.log(`[approve] ${c.tool} ${rv.path}: ${rv.hunks.length} hunk(s) ${rv.warnings.length ? "WARN " + rv.warnings.join("; ") : ""}`);
            out.push({ toolCallId: c.toolCallId, threadId: c.threadId, allow: true });
          } catch (e) {
            console.log(`[auto-reject] ${c.tool}: ${e.message}`);
            out.push({ toolCallId: c.toolCallId, threadId: c.threadId, allow: false, reason: e.message });
          }
        }
        return out;
      },
    },
  });
  console.log(`\n\n[result] ${res.status} model=${res.model} fellBack=${res.fellBack} session=${res.sessionId} ${(Date.now() - t0) / 1000}s ${res.error ?? ""}`);
  await mcp.close();
  process.exit(0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});

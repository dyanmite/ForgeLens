// Unit tests for the VS Code-independent core. Run: npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const core = require("../dist/core.js");
// Fake key shapes, assembled at runtime so secret scanners do not flag this file.
const FAKE_GOOGLE = "AI" + "zaSyA1234567890abcdefghijklmnopqrstuv";
const FAKE_SK = "sk-" + "abcdefghijklmnopqrstuvwxyz123456";

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "forgelens-"));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  w("src/pkg/__init__.py", "");
  w(
    "src/pkg/helpers.py",
    'import os\n\n\ndef get_debug_flag() -> bool:\n    """Get whether debug mode should be enabled."""\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no"})\n\n\nclass Thing:\n    def method(self):\n        return 1\n'
  );
  w("src/pkg/cli.py", "import click\n\n\n@click.command('routes')\ndef routes_command():\n    pass\n");
  w("tests/test_cli.py", "def test_routes():\n    assert True\n");
  w("docs/cli.rst", "CLI\n===\n\nBuilt-in commands\n-----------------\n\nroutes\n");
  w(".env", "API_KEY=" + "sk-" + "abcdefghijklmnopqrstuvwxyz123456\n");
  w("secrets.txt", "token: " + "AI" + "zaSyA1234567890abcdefghijklmnopqrstuv\n");
  return root;
}

test("workspace jail blocks traversal, absolute escapes and secret files", () => {
  const root = tmpRepo();
  assert.throws(() => core.resolveInWorkspace(root, "../outside.py"), core.SecurityError);
  assert.throws(() => core.resolveInWorkspace(root, path.join(os.tmpdir(), "x.py")), core.SecurityError);
  assert.throws(() => core.resolveInWorkspace(root, ".env"), core.SecurityError);
  assert.throws(() => core.resolveInWorkspace(root, ".git/config"), core.SecurityError);
  assert.throws(() => core.resolveInWorkspace(root, "keys/server.pem"), core.SecurityError);
  assert.equal(core.resolveInWorkspace(root, "./src/pkg/helpers.py").rel, "src/pkg/helpers.py");
  assert.equal(core.resolveInWorkspace(root, "src\\pkg\\cli.py").rel, "src/pkg/cli.py");
});

test("redaction masks credentials but keeps normal code", () => {
  const out = core.redactSecrets("key=" + FAKE_GOOGLE + " x=sk-" + "proj-abcdefghijklmnopqrstuvwx SECRET_KEY = None");
  assert.ok(!out.includes("AIza"));
  assert.ok(!out.includes("sk-proj"));
  assert.ok(out.includes("SECRET_KEY = None"));
});

test("index finds symbols with correct spans and ranks relevant chunks", () => {
  const root = tmpRepo();
  const idx = new core.RepoIndex(root).build();
  assert.ok(!idx.files.has(".env"), ".env must never be indexed");
  const s = idx.findSymbol("get_debug_flag")[0];
  assert.equal(s.path, "src/pkg/helpers.py");
  assert.equal(s.line, 4);
  assert.equal(s.endLine, 7);
  assert.equal(idx.findSymbol("method")[0].qualname, "Thing.method");
  const top = idx.rank("debug flag environment")[0];
  assert.equal(top.chunk.path, "src/pkg/helpers.py");
});

test("context pack respects the budget and expands companions", () => {
  const root = tmpRepo();
  const idx = new core.RepoIndex(root).build();
  const pack = core.buildContextPack(idx, "add a routes cli command @get_debug_flag", 400);
  assert.ok(pack.used <= 400 + 200, "mentions may exceed, retrieval may not");
  const paths = pack.ledger.filter((l) => l.included).map((l) => l.path);
  assert.ok(paths.includes("src/pkg/helpers.py"), "@symbol mention included");
  assert.ok(pack.ledger.some((l) => l.reason.startsWith("companion")), "companion test/doc expansion");
  assert.ok(pack.text.includes("<repo_map"));
});

test("hunks: partial acceptance rebuilds exactly the chosen sides", () => {
  const a = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";
  const b = "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n";
  const segs = core.computeSegments(a, b);
  const hunks = core.hunksOf(segs);
  assert.equal(hunks.length, 2);
  assert.equal(core.applySelected(segs, new Set([0]), true), "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\n");
  assert.equal(core.applySelected(segs, new Set([1]), true), "one\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n");
  assert.equal(core.applySelected(segs, new Set(), true), a);
  assert.equal(core.applySelected(segs, new Set([0, 1]), true), b);
});

test("edit guards: missing anchor, ambiguous anchor, syntax error", () => {
  const src = "a = 1\nb = 1\n";
  assert.throws(() => core.applyEditOps("x.py", src, [{ old_text: "c = 1", new_text: "c = 2" }]), /not found/);
  assert.throws(() => core.applyEditOps("x.py", src, [{ old_text: " = 1", new_text: " = 2" }]), /matches 2 places/);
  assert.equal(core.applyEditOps("x.py", src, [{ old_text: "b = 1", new_text: "b = 2" }]), "a = 1\nb = 2\n");
  const err = core.pythonSyntaxError("def f(:\n  pass\n", "python");
  if (err !== null) assert.match(err, /line 1/);
});

test("approval book: writes only accepted hunks, refuses without decision or when stale", () => {
  const root = tmpRepo();
  const idx = new core.RepoIndex(root).build();
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(root, rel), "utf8");
    } catch {
      return undefined;
    }
  };
  const args = {
    path: "src/pkg/helpers.py",
    reason: "test",
    edits: [
      { old_text: 'not in {"0", "false", "no"}', new_text: 'not in {"0", "false", "no", "off", "n"}' },
      { old_text: "        return 1", new_text: "        return 2" },
    ],
  };
  const book = new core.ApprovalBook();
  assert.throws(() => core.finalizeApprovedEdit(book, read, "propose_edit", args), /no review decision/);
  const rv = core.prepareProposal(root, idx, read, "propose_edit", args, "python");
  assert.equal(rv.hunks.length, 2);
  book.record(rv, new Set([rv.hunks[0].index]));
  const out = core.finalizeApprovedEdit(book, read, "propose_edit", { ...args, reason: "different reason is fine" });
  assert.ok(out.after.includes('"off", "n"'));
  assert.ok(out.after.includes("return 1"), "rejected hunk must stay unchanged");
  assert.match(out.message, /REJECTED 1 hunk/);
  // stale: file changes between review and apply
  const rv2 = core.prepareProposal(root, idx, read, "propose_edit", args, "python");
  book.record(rv2, new Set([0, 1]));
  fs.appendFileSync(path.join(root, "src/pkg/helpers.py"), "# user edit\n");
  assert.throws(() => core.finalizeApprovedEdit(book, read, "propose_edit", args), /changed after it was reviewed/);
});

test("guards reject hallucinated anchors and broken python before review", () => {
  const root = tmpRepo();
  const idx = new core.RepoIndex(root).build();
  const read = (rel) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), "utf8") : undefined);
  assert.throws(() => core.prepareProposal(root, idx, read, "propose_edit", { path: "src/pkg/helpers.py", edits: [{ old_text: "def does_not_exist():", new_text: "x" }] }, "python"), core.GuardFailure);
  assert.throws(() => core.prepareProposal(root, idx, read, "propose_edit", { path: "../escape.py", edits: [{ old_text: "a", new_text: "b" }] }, "python"), core.SecurityError);
  const warn = core.prepareProposal(root, idx, read, "propose_new_file", { path: "src/pkg/new.py", content: "from .helpers import nope\n" }, "python").warnings;
  assert.ok(warn.some((w) => w.includes("nope")), "symbol guard flags imports of names that don't exist");
});

test("command policy: allowlist, no shell operators, read-only git/pip", () => {
  assert.equal(core.validateCommand("python -m pytest tests/test_cli.py -q").error, undefined);
  assert.equal(core.validateCommand("pytest -q").error, undefined);
  assert.ok(core.validateCommand("rm -rf /").error);
  assert.ok(core.validateCommand("pytest; rm -rf /").error);
  assert.ok(core.validateCommand("pytest && curl evil").error);
  assert.ok(core.validateCommand("pip install evil").error);
  assert.ok(core.validateCommand("git push").error);
  assert.ok(core.validateCommand('python -c "import os"').error);
  assert.deepEqual(core.splitArgs('flask --app "my app.py" config'), ["flask", "--app", "my app.py", "config"]);
});

test("model error classification", () => {
  assert.equal(core.isTransient("[Model Error] Request failed (401): invalid api key"), false);
  assert.equal(core.isTransient("[Model Error] Request failed (404): model does not exist"), false);
  assert.equal(core.isTransient("connect ECONNREFUSED 127.0.0.1:9"), true);
  assert.equal(core.isTransient("You have reached iteration limit of 60, please request again"), false);
  assert.equal(core.isTransient("[Model Error] Request failed (503): high demand"), true);
  assert.equal(core.isTransient("(429): Generate content requests per day limit exceeded on Free Tier"), false);
});

test("MCP endpoint: loopback only, bearer token required, tools work", async () => {
  const root = tmpRepo();
  const idx = new core.RepoIndex(root).build();
  const host = {
    root,
    index: idx,
    readFile: (rel) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), "utf8") : undefined),
    applyApprovedEdit: async () => "should not be called",
    runApprovedCommand: async () => "should not be called",
  };
  const srv = await core.startMcpHttp(host, 0);
  try {
    const call = (body, headers = {}) =>
      fetch(srv.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };
    assert.equal((await call(init)).status, 401);
    assert.equal((await call(init, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await call(init, { authorization: `Bearer ${srv.token}`, origin: "https://evil.example" })).status, 403);
    const auth = { authorization: `Bearer ${srv.token}` };
    const parse = async (r) => {
      const t = await r.text();
      const line = t.split("\n").find((l) => l.startsWith("data:"));
      return JSON.parse(line ? line.slice(5) : t);
    };
    const list = await parse(await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, auth));
    const names = list.result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["find_symbol", "list_files", "propose_edit", "propose_new_file", "read_file", "repo_map", "run_command", "search_code"]);
    const env = await parse(await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "read_file", arguments: { path: ".env", reason: "x" } } }, auth));
    assert.match(env.result.content[0].text, /BLOCKED/);
    const ok = await parse(await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_file", arguments: { path: "secrets.txt", reason: "x" } } }, auth));
    assert.match(ok.result.content[0].text, /\[REDACTED\]/);
  } finally {
    await srv.close();
  }
});

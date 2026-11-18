// The editor's capabilities, exposed to the TrueForge agent as MCP tools.
//
// The agent - not the extension - decides what to read and change. The extension
// only (a) serves these tools and (b) renders TrueForge's approval requests as a
// per-hunk review. Write tools never touch disk on their own: they apply exactly
// the hunks the user accepted for that tool call, and refuse if no decision exists.
//
// Transport: MCP Streamable HTTP, stateless, bound to 127.0.0.1 only, guarded by a
// random bearer token (registered in TrueForge as a header-auth connector), a Host
// header check (DNS-rebinding) and a no-browser-Origin rule.
import * as http from "http";
import * as crypto from "crypto";
import * as fs from "fs";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { RepoIndex, globToRegExp, estimateTokens } from "./repoIndex";
import { resolveInWorkspace, redactSecrets, SecurityError } from "./security";

export const SERVER_NAME = "forgelens-editor";

export interface ToolActivity {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  path?: string;
  lines?: [number, number];
  tokens?: number;
}

export interface EditorHost {
  root: string;
  index: RepoIndex;
  /** Live text of a file (unsaved editor buffer wins over disk), "\n" or "\r\n" as stored. */
  readFile(rel: string): string | undefined;
  /** Apply the user-approved hunks for this exact call. Must refuse if there is no decision. */
  applyApprovedEdit(tool: "propose_edit" | "propose_new_file", args: Record<string, unknown>): Promise<string>;
  runApprovedCommand(args: { command: string; reason?: string }): Promise<string>;
  onActivity?(a: ToolActivity): void;
}

/** Canonical key used to match an approval decision to the MCP call that follows it. */
export function callKey(tool: string, args: Record<string, unknown>): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) if (k !== "reason") o[k] = norm((v as Record<string, unknown>)[k]);
      return o;
    }
    if (typeof v === "string") return v.replace(/\r\n/g, "\n");
    return v;
  };
  return tool + ":" + crypto.createHash("sha256").update(JSON.stringify(norm(args))).digest("hex");
}

const MAX_READ_LINES = 400;

function text(s: string, isError = false) {
  return { content: [{ type: "text" as const, text: s }], isError };
}

export function buildMcpServer(host: EditorHost): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: "0.1.0" }, { capabilities: { tools: {} } });
  const act = (a: ToolActivity) => {
    try {
      host.onActivity?.(a);
    } catch {
      /* ignore UI errors */
    }
  };
  const guard = async (tool: string, args: Record<string, unknown>, fn: () => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) => {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof SecurityError ? `BLOCKED: ${e.message}` : `ERROR: ${(e as Error).message}`;
      act({ tool, args, ok: false, summary: msg });
      return text(msg, true);
    }
  };

  server.registerTool(
    "repo_map",
    {
      title: "Repository map",
      description:
        "Compact outline of the repository: every indexed file with its line count and top-level classes/functions (or doc sections), ranked by relevance to `query`. Cheap; call it first to orient yourself in a large repo.",
      inputSchema: { query: z.string().optional().describe("What you are looking for; files are ranked by relevance to it"), budget_tokens: z.number().int().min(200).max(4000).optional() },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard("repo_map", args, () => {
        const map = host.index.repoMap(args.query, args.budget_tokens ?? 1500);
        act({ tool: "repo_map", args, ok: true, summary: `outline ranked by "${args.query ?? ""}"`, tokens: estimateTokens(map) });
        return text(map);
      })
  );

  server.registerTool(
    "search_code",
    {
      title: "Search code",
      description: "Search indexed files for a literal string (or a regex with regex=true). Returns path:line: text for each hit. Use glob (e.g. 'tests/*.py', 'docs/**') to narrow.",
      inputSchema: {
        query: z.string().min(1),
        regex: z.boolean().optional(),
        glob: z.string().optional(),
        max_results: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard("search_code", args, () => {
        const { hits, total } = host.index.search(args.query, { isRegex: args.regex, glob: args.glob, maxResults: args.max_results ?? 40 });
        const body = hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join("\n");
        const more = total > hits.length ? `\n… ${total - hits.length} more hits; narrow with glob or a more specific query.` : "";
        act({ tool: "search_code", args, ok: true, summary: `${total} hit(s) for "${args.query}"` });
        return text(redactSecrets(hits.length ? body + more : `no matches for ${JSON.stringify(args.query)}`));
      })
  );

  server.registerTool(
    "find_symbol",
    {
      title: "Find symbol",
      description: "Locate a class, function, method or module constant by name (exact first, then substring). Returns kind, qualified name and path:start-end lines.",
      inputSchema: { name: z.string().min(1) },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard("find_symbol", args, () => {
        const hits = host.index.findSymbol(args.name);
        act({ tool: "find_symbol", args, ok: true, summary: `${hits.length} match(es) for ${args.name}` });
        if (!hits.length) return text(`no symbol named ${args.name} in the repository index. It may not exist.`);
        return text(hits.map((s) => `${s.kind} ${s.qualname} — ${s.path}:${s.line}-${s.endLine}`).join("\n"));
      })
  );

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: `Read a workspace file (or a line range). At most ${MAX_READ_LINES} lines per call. Always say WHY you are reading it in \`reason\`: the user sees it in the context ledger. Copy text from here verbatim when you build old_text for propose_edit.`,
      inputSchema: {
        path: z.string().describe("workspace-relative path, e.g. src/flask/cli.py"),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
        reason: z.string().describe("one line: why this file is relevant to the task"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard("read_file", args, () => {
        const { rel } = resolveInWorkspace(host.root, args.path);
        const raw = host.readFile(rel);
        if (raw === undefined) throw new Error(`file not found: ${rel}. Use repo_map or search_code to find the right path.`);
        const lines = raw.replace(/\r\n/g, "\n").split("\n");
        const start = Math.max(1, args.start_line ?? 1);
        const end = Math.min(lines.length, args.end_line ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
        const body = lines.slice(start - 1, end).join("\n");
        const note = end < lines.length ? `\n[… file continues: lines ${end + 1}-${lines.length}. Call read_file with start_line=${end + 1} to read more.]` : "";
        act({ tool: "read_file", args, ok: true, summary: args.reason ?? "", path: rel, lines: [start, end], tokens: estimateTokens(body) });
        return text(`# ${rel} (lines ${start}-${end} of ${lines.length})\n${redactSecrets(body)}${note}`);
      })
  );

  server.registerTool(
    "list_files",
    {
      title: "List files",
      description: "List indexed files under a directory, optionally filtered by glob. Prefer repo_map for an overview.",
      inputSchema: { dir: z.string().optional(), glob: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async (args) =>
      guard("list_files", args, () => {
        const dir = args.dir ? resolveInWorkspace(host.root, args.dir).rel.replace(/\/$/, "") : ".";
        const g = args.glob ? globToRegExp(args.glob) : undefined;
        const files = [...host.index.files.keys()].filter((p) => (dir === "." || p.startsWith(dir + "/")) && (!g || g.test(p))).sort();
        act({ tool: "list_files", args, ok: true, summary: `${files.length} file(s) in ${dir}` });
        return text(files.slice(0, 300).join("\n") + (files.length > 300 ? `\n… ${files.length - 300} more` : "") || "no files");
      })
  );

  server.registerTool(
    "propose_edit",
    {
      title: "Propose edit",
      description:
        "Propose changes to ONE existing file as exact search/replace pairs. Nothing is written until the user reviews the diff hunk by hunk; the result tells you which hunks were accepted or rejected. old_text must be copied verbatim from read_file output and match exactly once. Keep edits minimal; never rewrite code you were not asked to change.",
      inputSchema: {
        path: z.string(),
        edits: z.array(z.object({ old_text: z.string().describe("exact existing text, unique in the file"), new_text: z.string() })).min(1),
        reason: z.string().describe("why this change is needed (shown to the reviewer)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard("propose_edit", args, async () => {
        resolveInWorkspace(host.root, args.path);
        const res = await host.applyApprovedEdit("propose_edit", args as Record<string, unknown>);
        act({ tool: "propose_edit", args, ok: true, summary: res, path: args.path });
        return text(res);
      })
  );

  server.registerTool(
    "propose_new_file",
    {
      title: "Propose new file",
      description: "Propose creating a NEW file with the given content. The user reviews it before it is written. Fails if the file already exists (use propose_edit).",
      inputSchema: { path: z.string(), content: z.string(), reason: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async (args) =>
      guard("propose_new_file", args, async () => {
        const { abs } = resolveInWorkspace(host.root, args.path);
        if (fs.existsSync(abs)) throw new Error(`${args.path} already exists; use propose_edit`);
        const res = await host.applyApprovedEdit("propose_new_file", args as Record<string, unknown>);
        act({ tool: "propose_new_file", args, ok: true, summary: res, path: args.path });
        return text(res);
      })
  );

  server.registerTool(
    "run_command",
    {
      title: "Run command",
      description:
        "Run ONE allowlisted command in the workspace root after the user approves it: pytest, python -m pytest, flask, pip show/list, git status/diff/log. No shell operators. Use it to run the tests that cover your change.",
      inputSchema: { command: z.string(), reason: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) =>
      guard("run_command", args, async () => {
        const res = await host.runApprovedCommand(args);
        act({ tool: "run_command", args, ok: !res.startsWith("REFUSED"), summary: res.split("\n").slice(-1)[0] ?? "" });
        return text(res);
      })
  );

  return server;
}

export interface RunningMcp {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

/** Start the MCP endpoint at http://127.0.0.1:<port>/mcp. port=0 picks a free port. */
export async function startMcpHttp(host: EditorHost, port: number, log: (m: string) => void = () => {}): Promise<RunningMcp> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const httpServer = http.createServer(async (req, res) => {
    try {
      const hostHdr = (req.headers.host ?? "").split(":")[0];
      if (!["127.0.0.1", "localhost", "[::1]"].includes(hostHdr)) return deny(res, 403, "bad host");
      if (req.headers.origin && req.headers.origin !== "null") return deny(res, 403, "browser origins are not allowed");
      const auth = Buffer.from(String(req.headers.authorization ?? ""));
      if (auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) return deny(res, 401, "unauthorized");
      if (!req.url?.startsWith("/mcp")) return deny(res, 404, "not found");
      if (req.method !== "POST") return deny(res, 405, "stateless server: POST only");
      const body = await readBody(req, 8 * 1024 * 1024);
      // Stateless: a fresh server+transport per request, as recommended by the SDK.
      const mcp = buildMcpServer(host);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close().catch(() => {});
        mcp.close().catch(() => {});
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      log(`mcp request failed: ${(e as Error).message}`);
      if (!res.headersSent) deny(res, 500, "internal error");
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => resolve());
  });
  const actual = (httpServer.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${actual}/mcp`,
    token,
    port: actual,
    close: () => new Promise((r) => httpServer.close(() => r())),
  };
}

function deny(res: http.ServerResponse, code: number, msg: string) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: msg }));
}

function readBody(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

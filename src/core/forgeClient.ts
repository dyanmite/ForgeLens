// Everything that talks to TrueForge lives here. The extension never calls a model
// provider: it creates TrueForge sessions, sends turns, renders the streamed
// events, and answers TrueForge's tool-approval requests.
//
// Resilience: TrueForge runs one model per agent, so model fallback is done here,
// on top of the harness: transient errors are retried with exponential backoff,
// then the SAME session is switched to the next configured model
// (sessions.update with a new agent spec) and the turn is re-issued. History and
// tool results are preserved because the session is preserved.
import * as fs from "fs";
import * as path from "path";
import { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { SERVER_NAME } from "./mcpServer";

export type AgentKind = "agent" | "inline";

export interface PendingCall {
  toolCallId: string;
  threadId: string;
  tool: string; // effective MCP tool name (unwrapped from deferred call_tool)
  server?: string;
  args: Record<string, unknown>;
}

export interface Decision {
  toolCallId: string;
  threadId: string;
  allow: boolean;
  reason?: string;
}

export interface RunCallbacks {
  onStatus(s: { phase: "starting" | "running" | "paused" | "retrying" | "fallback" | "done" | "error" | "cancelled"; model: string; message?: string; sessionId?: string }): void;
  onDelta?(threadId: string, messageId: string, chunk: string, kind: "content" | "reasoning"): void;
  onToolCall?(threadId: string, call: PendingCall, display: string): void;
  onToolResult?(threadId: string, toolCallId: string, content: string): void;
  onThread?(threadId: string, title: string, phase: "started" | "done", detail?: string): void;
  onCompaction?(threadId: string, phase: "started" | "finished"): void;
  onApproval?(calls: PendingCall[]): Promise<Decision[]>;
}

export interface RunResult {
  sessionId: string;
  status: "done" | "cancelled" | "error";
  output: string;
  model: string;
  error?: string;
  fellBack: boolean;
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
/** Agent files are stored in TrueForge's wire format (snake_case); the SDK wants camelCase keys. */
function camelize(v: unknown, parentKey = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => camelize(x, parentKey));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[camel(k)] = camelize(val, k);
    return o;
  }
  return v;
}

export class ForgeClient {
  client: TrueForge;
  private agentFiles: Record<AgentKind, { name: string; description: string; manifest: Record<string, unknown> }>;

  constructor(public baseUrl: string, agentsDir: string) {
    this.client = new TrueForge({ baseUrl, timeoutInSeconds: 3600 });
    const load = (f: string) => JSON.parse(fs.readFileSync(path.join(agentsDir, f), "utf8"));
    this.agentFiles = { agent: load("forgelens-agent.json"), inline: load("forgelens-inline.json") };
  }

  spec(kind: AgentKind, model: string): TrueForgeApi.AgentSpec {
    const raw = JSON.parse(JSON.stringify(this.agentFiles[kind].manifest).split("${MODEL}").join(model));
    return camelize(raw) as TrueForgeApi.AgentSpec;
  }

  async ping(): Promise<void> {
    try {
      await this.client.server.getCapabilities();
    } catch (e) {
      throw new Error(`TrueForge is not reachable at ${this.baseUrl}. Start it with \`npx @truefoundry/trueforge@latest\` (${shortErr(e)})`);
    }
  }

  async listModels(): Promise<string[]> {
    const r = await this.client.models.list();
    return ((r as { data?: { name: string }[] }).data ?? []).map((m) => m.name);
  }

  /** Register (or refresh) the editor MCP server as a TrueForge connector with header auth. */
  async registerConnector(url: string, token: string) {
    await this.client.settings.mcpServers.createOrUpdate({
      manifest: {
        type: "remote",
        name: SERVER_NAME,
        description: "ForgeLens VS Code editor tools (read, search, symbols, reviewed edits, allowlisted commands). Local only.",
        url,
        auth: { type: "header", headers: { Authorization: `Bearer ${token}` } },
      } as TrueForgeApi.McpServerManifest,
    });
  }

  /** Mirror the repo's agent definitions into the TrueForge registry so they are visible in the UI. */
  async registerAgents(primaryModel: string) {
    const existing = new Map<string, string>();
    try {
      const page = await this.client.agents.list();
      for await (const a of page as AsyncIterable<{ id: string; name: string }>) existing.set(a.name, a.id);
    } catch {
      /* listing is best-effort */
    }
    for (const kind of ["agent", "inline"] as AgentKind[]) {
      const f = this.agentFiles[kind];
      const manifest = this.spec(kind, primaryModel);
      const id = existing.get(f.name);
      if (id) await this.client.agents.update(id, { description: f.description, manifest } as never);
      else await this.client.agents.create({ name: f.name, description: f.description, manifest } as never);
    }
  }

  private sessionCalls = new Map<string, Map<string, PendingCall>>();

  /** Recover tool-call arguments from TrueForge's persisted session history. */
  private async backfillCalls(sessionId: string, calls: Map<string, PendingCall>) {
    try {
      const page = await this.client.sessions.listEvents(sessionId);
      let n = 0;
      for await (const item of page as AsyncIterable<{ event: TrueForgeApi.SessionEvent }>) {
        const ev = item.event as { type: string; threadId?: string; toolCalls?: TrueForgeApi.ToolCall[] };
        if (ev.type === "model.message") for (const tc of ev.toolCalls ?? []) if (!calls.has(tc.id)) calls.set(tc.id, unwrapCall(tc, ev.threadId ?? "main"));
        if (++n > 400) break;
      }
    } catch {
      /* best effort */
    }
  }

  async cancel(sessionId: string) {
    try {
      await this.client.sessions.cancel(sessionId, {});
    } catch {
      /* already finished */
    }
  }

  /**
   * Run one user turn with retry + model fallback.
   * `existingSession` lets the agent panel keep a multi-turn conversation.
   */
  async run(opts: {
    kind: AgentKind;
    models: string[];
    input: string;
    retries: number;
    existingSession?: { id: string; model: string };
    signal: AbortSignal;
    cb: RunCallbacks;
    title?: string;
  }): Promise<RunResult> {
    const { kind, models, cb, signal } = opts;
    if (!models.length) throw new Error("no models configured (setting forgelens.models)");
    let sessionId = opts.existingSession?.id;
    let sessionModel = opts.existingSession?.model;
    let input = opts.input;
    const failures: string[] = [];
    let fellBack = false;

    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      for (let attempt = 0; attempt <= opts.retries; attempt++) {
        if (signal.aborted) return { sessionId: sessionId ?? "", status: "cancelled", output: "", model, fellBack };
        let progressed = false;
        try {
          if (!sessionId) {
            cb.onStatus({ phase: "starting", model });
            const s = await this.client.sessions.create({ agent: { spec: this.spec(kind, model) } }, { abortSignal: signal });
            sessionId = (s as { data: { id: string } }).data.id;
            sessionModel = model;
            if (opts.title) this.client.sessions.update(sessionId, { title: opts.title.slice(0, 120) }).catch(() => {});
          } else if (sessionModel !== model) {
            await this.client.sessions.update(sessionId, { agent: { spec: this.spec(kind, model) } }, { abortSignal: signal });
            sessionModel = model;
          }
          cb.onStatus({ phase: "running", model, sessionId });
          const r = await this.streamTurn(sessionId, input, model, signal, cb, () => (progressed = true));
          if (r.status !== "error") return { ...r, sessionId, model, fellBack };
          throw new TurnError(r.error ?? "unknown error");
        } catch (e) {
          if (signal.aborted || isAbort(e)) {
            if (sessionId) await this.cancel(sessionId);
            return { sessionId: sessionId ?? "", status: "cancelled", output: "", model, fellBack };
          }
          const msg = shortErr(e);
          if (!(e instanceof TurnError)) {
            const status = (e as { statusCode?: number }).statusCode;
            // TrueForge itself is down: no model can help.
            if (status === undefined) await this.ping();
            // A request TrueForge rejected for reasons unrelated to the model is a
            // bug/config problem, not something a fallback model can fix.
            if (status !== undefined && status >= 400 && status < 500 && !/model|provider/i.test(msg)) throw e;
          }
          failures.push(`${model}: ${msg}`);
          const transient = isTransient(msg);
          // If the failed turn already did work (tool calls), don't replay the request; ask to continue.
          if (progressed) input = `The previous attempt stopped with an error (${msg.slice(0, 200)}). Continue the task from where it stopped; do not redo changes that were already accepted.`;
          if (transient && attempt < opts.retries) {
            // Rate limits need a real pause; connection errors get a quick exponential backoff.
            const delay = /\(429\)|rate.?limit|quota/i.test(msg) ? 6000 * (attempt + 1) : 800 * 2 ** attempt;
            cb.onStatus({ phase: "retrying", model, message: `${msg} — retry ${attempt + 1}/${opts.retries} in ${(delay / 1000).toFixed(1)}s`, sessionId });
            await sleep(delay, signal);
            continue;
          }
          break; // next model
        }
      }
      if (mi + 1 < models.length) {
        fellBack = true;
        cb.onStatus({ phase: "fallback", model: models[mi + 1], message: `${model} failed (${failures[failures.length - 1].slice(model.length + 2, model.length + 160)}). Switching to ${models[mi + 1]} automatically.`, sessionId });
      }
    }
    const error = `All configured models failed.\n${failures.map((f) => "• " + f).join("\n")}`;
    cb.onStatus({ phase: "error", model: models[models.length - 1], message: error, sessionId });
    return { sessionId: sessionId ?? "", status: "error", output: "", model: models[models.length - 1], error, fellBack };
  }

  private async streamTurn(sessionId: string, content: string, model: string, signal: AbortSignal, cb: RunCallbacks, markProgress: () => void): Promise<{ status: "done" | "cancelled" | "error"; output: string; error?: string }> {
    const stream = await this.client.sessions.createTurnStream(sessionId, { input: [{ type: "user.message", content }] } as never, { abortSignal: signal, timeoutInSeconds: 3600 });
    let turnId = "";
    // Tool calls are remembered per session: an approval can refer to a call made
    // in an earlier turn (e.g. one that was interrupted by a model failure).
    let calls = this.sessionCalls.get(sessionId);
    if (!calls) this.sessionCalls.set(sessionId, (calls = new Map()));
    const deltaSeen = new Set<string>();
    let output = "";
    const onAbort = () => void this.cancel(sessionId);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      for await (const ev of stream as AsyncIterable<TrueForgeApi.TurnStreamingEvent>) {
        switch (ev.type) {
          case "turn.created":
            turnId = ev.turnId;
            break;
          case "model.message.delta": {
            deltaSeen.add(ev.id);
            if (ev.content) cb.onDelta?.(ev.threadId, ev.id, ev.content, "content");
            if (ev.reasoningContent) cb.onDelta?.(ev.threadId, ev.id, ev.reasoningContent, "reasoning");
            break;
          }
          case "model.message": {
            const text = typeof ev.content === "string" ? ev.content : ev.content ? JSON.stringify(ev.content) : "";
            if (!deltaSeen.has(ev.id) && text) cb.onDelta?.(ev.threadId, ev.id, text, "content");
            if (ev.threadId === "main" && text) output = text;
            for (const tc of ev.toolCalls ?? []) {
              const pc = unwrapCall(tc, ev.threadId);
              calls.set(tc.id, pc);
              markProgress();
              cb.onToolCall?.(ev.threadId, pc, `${pc.tool}`);
            }
            break;
          }
          case "tool.response":
            cb.onToolResult?.(ev.threadId, ev.toolCallId, ev.content);
            break;
          case "thread.created":
            cb.onThread?.(ev.threadId, ev.title, "started", ev.agentInfo?.input);
            break;
          case "thread.done":
            cb.onThread?.(ev.threadId, ev.title, "done");
            break;
          case "thread.context_compaction.started" as never:
            cb.onCompaction?.((ev as { threadId: string }).threadId, "started");
            break;
          case "thread.context_compaction.finished" as never:
            cb.onCompaction?.((ev as { threadId: string }).threadId, "finished");
            break;
          case "turn.update":
            cb.onStatus({ phase: ev.state.status === "paused" ? "paused" : "running", model, sessionId });
            break;
          case "tool.approval_required": {
            if (ev.toolCalls.some((r) => !calls!.has(r.id))) await this.backfillCalls(sessionId, calls);
            const pending = ev.toolCalls.map((r) => calls!.get(r.id) ?? { toolCallId: r.id, threadId: ev.threadId, tool: "unknown", args: {} });
            for (const p of pending) p.threadId = p.threadId || ev.threadId;
            const decisions = cb.onApproval ? await cb.onApproval(pending) : pending.map((p) => ({ toolCallId: p.toolCallId, threadId: p.threadId, allow: false, reason: "no reviewer attached" }));
            if (signal.aborted) break;
            await this.client.sessions.createTurnEvents(sessionId, turnId, {
              events: decisions.map((d) => ({
                type: "user.tool_approval",
                threadId: d.threadId,
                toolCallId: d.toolCallId,
                approval: d.allow ? { status: "allow" } : { status: "deny", reason: d.reason ?? "rejected by the user" },
              })),
            } as never);
            break;
          }
          case "turn.done": {
            const st = ev.state as { status: string; message?: string; output?: { content?: unknown } };
            if (st.output?.content && typeof st.output.content === "string") output = st.output.content;
            if (st.status === "done") return { status: "done", output };
            if (st.status === "cancelled") return { status: "cancelled", output };
            return { status: "error", output, error: st.message ?? "turn failed" };
          }
        }
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) return { status: "cancelled", output };
    return { status: "error", output, error: "stream ended without turn.done" };
  }
}

class TurnError extends Error {}

export function unwrapCall(tc: TrueForgeApi.ToolCall, threadId: string): PendingCall {
  let args: Record<string, unknown> = {};
  try {
    args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
  } catch {
    args = { _raw: tc.function.arguments };
  }
  const info = tc.toolInfo as { type: string; name: string; serverName?: string } | undefined;
  if (info?.type === "mcp") return { toolCallId: tc.id, threadId, tool: info.name, server: info.serverName, args };
  // Deferred tool loading: the model calls the harness meta-tool `call_tool`
  // with the real server/tool inside its arguments.
  if (info?.type === "truefoundry-system" && /call_tool$/.test(info.name)) {
    const inner = (args.arguments ?? args.args ?? args.input ?? args.body ?? args.tool_input ?? {}) as Record<string, unknown>;
    const parsed = typeof inner === "string" ? safeJson(inner) : inner;
    return { toolCallId: tc.id, threadId, tool: String(args.tool_name ?? args.name ?? "call_tool"), server: String(args.mcp_server ?? args.server ?? ""), args: parsed };
  }
  return { toolCallId: tc.id, threadId, tool: info?.name ?? tc.function.name, server: info?.serverName, args };
}

function safeJson(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

export function isTransient(msg: string): boolean {
  if (/\((401|403)\)|invalid.*(api)?.?key|unauthori[sz]ed|permission denied|API key not valid/i.test(msg)) return false; // auth: retrying won't help
  if (/\(404\)|does not exist|not found/i.test(msg)) return false; // wrong model id: retrying won't help
  // Everything else (connection refused, DNS, timeouts, 429, 5xx, dropped streams,
  // unknown provider errors) is worth a retry with backoff before falling back.
  return true;
}

export function shortErr(e: unknown): string {
  const any = e as { message?: string; body?: unknown; statusCode?: number };
  let m = any?.message ?? String(e);
  if (any?.body && typeof any.body === "object") m += " " + JSON.stringify(any.body).slice(0, 300);
  return m.replace(/\s+/g, " ").trim().slice(0, 500);
}

function isAbort(e: unknown) {
  const n = (e as { name?: string })?.name;
  return n === "AbortError" || /aborted/i.test(String((e as Error)?.message));
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

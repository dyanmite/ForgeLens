// Agent mode: the side panel. One request drives a TrueForge agent through the
// editor's MCP tools; every write comes back here as an approval request and is
// rendered as a per-hunk review before anything touches disk.
import * as vscode from "vscode";
import * as crypto from "crypto";
import * as path from "path";
import { ForgeClient, PendingCall, Decision } from "../core/forgeClient";
import { WorkspaceHost } from "./workspaceHost";
import { buildContextPack } from "../core/contextPack";
import { prepareProposal, GuardFailure, PreparedReview } from "../core/review";
import { validateCommand, pythonFor } from "../core/commands";
import { ProposedContentProvider } from "./proposedContent";
import { applySelected } from "../core/hunks";
import { Settings } from "./settings";

type Pending = { resolve: (d: Decision) => void; call: PendingCall; review?: PreparedReview };

export class AgentPanel implements vscode.WebviewViewProvider {
  static readonly viewId = "forgelens.agentView";
  private view?: vscode.WebviewView;
  private session?: { id: string; model: string };
  private abort?: AbortController;
  private pending = new Map<string, Pending>(); // reviewId -> pending approval
  private runCounter = 0;
  private lastRunId?: string;
  private queued: unknown[] = [];

  constructor(
    private ctx: vscode.ExtensionContext,
    private host: WorkspaceHost,
    private forge: () => ForgeClient,
    private settings: () => Settings,
    private proposed: ProposedContentProvider,
    private setGenerating: (on: boolean, who: "agent" | "inline") => void
  ) {
    host.activityListeners.push((a) => {
      if (a.tool === "read_file" && a.ok && a.path) this.post({ type: "ledgerAdd", entry: { path: a.path, startLine: a.lines?.[0] ?? 0, endLine: a.lines?.[1] ?? 0, tokens: a.tokens ?? 0, reason: a.summary || "read by agent", source: "agent", included: true } });
    });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(16).toString("base64");
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css"));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js"));
    view.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${view.webview.cspSource} data:;">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.post({ type: "notice", level: "error", text: String(e?.message ?? e) })));
    view.onDidChangeVisibility(() => view.visible && this.flush());
    this.flush();
    this.post({ type: "config", models: this.settings().models, url: this.settings().trueforgeUrl });
  }

  post(m: unknown) {
    if (this.view?.visible) {
      void this.view.webview.postMessage(m);
    } else {
      this.queued.push(m);
      if (this.queued.length > 5000) this.queued.shift();
    }
  }

  private flush() {
    if (!this.view?.visible) return;
    const q = this.queued;
    this.queued = [];
    for (const m of q) void this.view.webview.postMessage(m);
  }

  notice(level: "info" | "warn" | "error", text: string) {
    this.post({ type: "notice", level, text });
  }

  private async onMessage(m: { type: string; [k: string]: unknown }) {
    switch (m.type) {
      case "send":
        return this.send(String(m.text ?? ""));
      case "stop":
        return this.stop();
      case "newChat":
        this.session = undefined;
        this.post({ type: "reset" });
        return;
      case "reviewDecision":
        return this.decide(String(m.reviewId), (m.accepted as number[]) ?? [], Boolean(m.allow));
      case "openDiff":
        return this.openDiff(String(m.reviewId), (m.accepted as number[] | undefined) ?? undefined);
      case "openFile": {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(this.host.root, String(m.path))));
        const line = Math.max(0, Number(m.line ?? 1) - 1);
        await vscode.window.showTextDocument(doc, { selection: new vscode.Range(line, 0, line, 0), preview: true, preserveFocus: true });
        return;
      }
      case "mentionQuery":
        return this.mentions(String(m.q ?? ""));
      case "openSession":
        return this.openSession();
      case "undoLast":
        return vscode.commands.executeCommand("forgelens.undoLast");
      case "revertRun":
        return vscode.commands.executeCommand("forgelens.revertRun");
    }
  }

  openSession() {
    if (!this.session) return void vscode.window.showInformationMessage("No TrueForge session yet.");
    void vscode.env.openExternal(vscode.Uri.parse(`${this.settings().trueforgeUrl}/sessions/${this.session.id}`));
  }

  get lastRun() {
    return this.lastRunId;
  }

  async send(text: string) {
    text = text.trim();
    if (!text) return;
    if (this.abort) return this.notice("warn", "A run is already in progress. Stop it first.");
    const s = this.settings();
    const runId = `run-${++this.runCounter}-${Date.now()}`;
    this.lastRunId = runId;
    this.host.currentRunId = runId;
    this.abort = new AbortController();
    this.setGenerating(true, "agent");
    this.post({ type: "user", text, runId });

    // Context assembly happens in the editor, before the agent starts exploring.
    const pack = buildContextPack(this.host.index, text, s.contextBudget);
    this.post({ type: "context", ledger: pack.ledger, budget: pack.budget, used: pack.used, mapTokens: pack.mapTokens });
    const input = `${text}\n\n${pack.text}`;

    const forge = this.forge();
    try {
      const res = await forge.run({
        kind: "agent",
        models: s.models,
        input,
        retries: s.retries,
        existingSession: this.session,
        signal: this.abort.signal,
        title: text.slice(0, 80),
        cb: {
          onStatus: (st) => {
            if (st.sessionId) this.session = { id: st.sessionId, model: st.model };
            this.post({ type: "status", ...st, url: st.sessionId ? `${s.trueforgeUrl}/sessions/${st.sessionId}` : undefined });
          },
          onDelta: (threadId, id, chunk, kind) => this.post({ type: "delta", threadId, id, chunk, kind }),
          onToolCall: (threadId, call) => this.post({ type: "toolCall", threadId, id: call.toolCallId, tool: call.tool, args: summarizeArgs(call.args) }),
          onToolResult: (threadId, id, content) => this.post({ type: "toolResult", threadId, id, content: content.slice(0, 1500) }),
          onThread: (threadId, title, phase, detail) => this.post({ type: "thread", threadId, title, phase, detail }),
          onCompaction: (threadId, phase) => this.post({ type: "compaction", threadId, phase }),
          onApproval: (calls) => this.review(calls),
        },
      });
      if (res.sessionId) this.session = { id: res.sessionId, model: res.model };
      const changes = this.host.runChanges(runId);
      this.post({ type: "done", status: res.status, error: res.error, model: res.model, fellBack: res.fellBack, changes: changes.map((c) => c.rel), runId });
      if (res.status === "cancelled") this.notice("info", changes.length ? `Run cancelled. ${changes.length} change(s) you accepted earlier in this run are still applied — use "Revert run" to roll them back. Nothing is half-applied.` : "Run cancelled. The workspace is unchanged.");
    } catch (e) {
      this.post({ type: "done", status: "error", error: String((e as Error).message ?? e), runId, changes: [] });
    } finally {
      this.denyAllPending("run ended");
      this.abort = undefined;
      this.setGenerating(false, "agent");
    }
  }

  stop() {
    if (!this.abort) return;
    this.abort.abort();
    this.host.killCommands();
    this.denyAllPending("cancelled by the user");
    this.post({ type: "status", phase: "cancelled", model: this.session?.model ?? "" });
  }

  get running() {
    return !!this.abort;
  }

  /** TrueForge paused for approval: turn each call into a review card and wait for the user. */
  private async review(calls: PendingCall[]): Promise<Decision[]> {
    const out: Promise<Decision>[] = [];
    const py = pythonFor(this.host.root);
    for (const call of calls) {
      const reviewId = crypto.randomUUID();
      if (call.tool === "propose_edit" || call.tool === "propose_new_file") {
        let rv: PreparedReview;
        try {
          rv = prepareProposal(this.host.root, this.host.index, (r) => this.host.readFile(r), call.tool, call.args, py);
        } catch (e) {
          const reason = (e as Error).message;
          this.post({ type: "autoRejected", tool: call.tool, path: String(call.args.path ?? ""), reason });
          out.push(Promise.resolve({ toolCallId: call.toolCallId, threadId: call.threadId, allow: false, reason: `ForgeLens guard rejected this edit before review: ${reason}` }));
          continue;
        }
        this.proposed.set(reviewId, rv.after);
        out.push(
          new Promise<Decision>((resolve) => {
            this.pending.set(reviewId, { resolve, call, review: rv });
            this.post({
              type: "review",
              reviewId,
              path: rv.path,
              isNew: rv.isNew,
              reason: rv.reason,
              warnings: rv.warnings,
              hunks: rv.hunks.map((h) => ({ index: h.index, oldStart: h.oldStart, newStart: h.newStart, before: h.contextBefore, removed: h.oldLines, added: h.newLines, after: h.contextAfter })),
            });
          })
        );
        void this.openDiff(reviewId);
      } else if (call.tool === "run_command") {
        const cmd = String(call.args.command ?? "");
        const v = validateCommand(cmd);
        if (v.error) {
          this.post({ type: "autoRejected", tool: "run_command", path: cmd, reason: v.error });
          out.push(Promise.resolve({ toolCallId: call.toolCallId, threadId: call.threadId, allow: false, reason: `ForgeLens policy: ${v.error}` }));
          continue;
        }
        out.push(
          new Promise<Decision>((resolve) => {
            this.pending.set(reviewId, { resolve, call });
            this.post({ type: "commandApproval", reviewId, command: cmd, reason: String(call.args.reason ?? "") });
          })
        );
      } else {
        // Unknown gated tool: be safe, deny.
        out.push(Promise.resolve({ toolCallId: call.toolCallId, threadId: call.threadId, allow: false, reason: `ForgeLens does not allow ${call.tool}` }));
      }
    }
    return Promise.all(out);
  }

  private decide(reviewId: string, accepted: number[], allow: boolean) {
    const p = this.pending.get(reviewId);
    if (!p) return;
    this.pending.delete(reviewId);
    if (p.review) {
      const acc = new Set(accepted.filter((i) => p.review!.hunks.some((h) => h.index === i)));
      if (!allow || acc.size === 0) {
        p.resolve({ toolCallId: p.call.toolCallId, threadId: p.call.threadId, allow: false, reason: `The user rejected all ${p.review.hunks.length} hunk(s) for ${p.review.path}. Do not propose the same change again; ask yourself whether it is needed.` });
        this.post({ type: "reviewClosed", reviewId, result: "rejected" });
      } else {
        this.host.book.record(p.review, acc);
        p.resolve({ toolCallId: p.call.toolCallId, threadId: p.call.threadId, allow: true });
        this.post({ type: "reviewClosed", reviewId, result: acc.size === p.review.hunks.length ? "accepted" : `partial ${acc.size}/${p.review.hunks.length}` });
      }
      this.proposed.delete(reviewId);
      closeDiffTabs(reviewId);
    } else {
      if (allow) this.host.commandApprovals.add(String(p.call.args.command ?? "").trim());
      p.resolve({ toolCallId: p.call.toolCallId, threadId: p.call.threadId, allow, reason: allow ? undefined : "The user declined to run this command." });
      this.post({ type: "reviewClosed", reviewId, result: allow ? "allowed" : "denied" });
    }
  }

  private denyAllPending(reason: string) {
    for (const [id, p] of this.pending) {
      p.resolve({ toolCallId: p.call.toolCallId, threadId: p.call.threadId, allow: false, reason });
      this.post({ type: "reviewClosed", reviewId: id, result: "cancelled" });
      this.proposed.delete(id);
      closeDiffTabs(id);
    }
    this.pending.clear();
  }

  private async openDiff(reviewId: string, accepted?: number[]) {
    const p = this.pending.get(reviewId);
    if (!p?.review) return;
    const rv = p.review;
    if (accepted) {
      this.proposed.set(reviewId, applySelected(rv.segs, new Set(accepted), true));
    }
    const left = rv.isNew ? vscode.Uri.parse(`forgelens-proposed:/empty/${reviewId}/${path.basename(rv.path)}`) : vscode.Uri.file(path.join(this.host.root, rv.path));
    const right = this.proposed.uriFor(reviewId, rv.path);
    await vscode.commands.executeCommand("vscode.diff", left, right, `ForgeLens review: ${rv.path} (${rv.hunks.length} hunk${rv.hunks.length === 1 ? "" : "s"})`, { preview: true, preserveFocus: true });
  }

  private mentions(q: string) {
    const low = q.toLowerCase();
    const files = [...this.host.index.files.keys()].filter((p) => p.toLowerCase().includes(low)).slice(0, 8).map((p) => ({ label: p, kind: "file" }));
    const syms = low.length >= 2 ? this.host.index.findSymbol(q, 8).map((s) => ({ label: s.qualname, kind: s.kind, detail: `${s.path}:${s.line}` })) : [];
    this.post({ type: "mentionResults", items: [...files, ...syms].slice(0, 12) });
  }
}

function closeDiffTabs(reviewId: string) {
  for (const g of vscode.window.tabGroups.all)
    for (const t of g.tabs) {
      const inp = t.input as { modified?: vscode.Uri } | undefined;
      if (inp?.modified?.scheme === "forgelens-proposed" && inp.modified.path.includes(reviewId)) void vscode.window.tabGroups.close(t);
    }
}

function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") out[k] = v.length > 300 ? v.slice(0, 300) + "…" : v;
    else if (Array.isArray(v)) out[k] = `[${v.length} item${v.length === 1 ? "" : "s"}]`;
    else out[k] = v;
  }
  return out;
}

// ForgeLens extension entry point.
//
//   VS Code ──(TrueForge TS SDK: sessions, turns, SSE events, approvals)──► TrueForge (local)
//      ▲                                                                       │
//      └──────────── MCP (Streamable HTTP, 127.0.0.1, bearer token) ◄──────────┘
//                    editor tools: read/search/symbols/reviewed edits/commands
import * as vscode from "vscode";
import * as path from "path";
import { ForgeClient } from "./core/forgeClient";
import { startMcpHttp, RunningMcp } from "./core/mcpServer";
import { WorkspaceHost } from "./vscode/workspaceHost";
import { AgentPanel } from "./vscode/agentPanel";
import { InlineEditController } from "./vscode/inlineEdit";
import { ProposedContentProvider } from "./vscode/proposedContent";
import { readSettings } from "./vscode/settings";

let mcp: RunningMcp | undefined;

export async function activate(ctx: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel("ForgeLens");
  ctx.subscriptions.push(log);
  const folder = vscode.workspace.workspaceFolders?.[0];
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "forgelens.reconnect";
  ctx.subscriptions.push(status);
  status.text = "$(sync~spin) ForgeLens";
  status.show();

  if (!folder) {
    status.text = "$(warning) ForgeLens: open a folder";
    const warn = () => vscode.window.showWarningMessage("ForgeLens needs an open workspace folder.");
    for (const c of ["forgelens.inlineEdit", "forgelens.focusAgent", "forgelens.reconnect"]) ctx.subscriptions.push(vscode.commands.registerCommand(c, warn));
    return;
  }

  const root = folder.uri.fsPath;
  const host = new WorkspaceHost(root, log);
  const t0 = Date.now();
  host.index.build();
  log.appendLine(`indexed ${host.index.files.size} files / ${host.index.chunks.length} chunks in ${Date.now() - t0}ms`);

  // keep the index fresh
  const reindex = debounceByKey((rel: string) => host.index.update(rel), 400);
  const toRel = (u: vscode.Uri) => path.relative(root, u.fsPath).split(path.sep).join("/");
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/*"));
  ctx.subscriptions.push(
    watcher,
    watcher.onDidChange((u) => reindex(toRel(u))),
    watcher.onDidCreate((u) => reindex(toRel(u))),
    watcher.onDidDelete((u) => reindex(toRel(u))),
    vscode.workspace.onDidSaveTextDocument((d) => reindex(toRel(d.uri)))
  );

  let settings = readSettings();
  let forge = new ForgeClient(settings.trueforgeUrl, path.join(ctx.extensionPath, "agents"));
  let connected = false;

  const proposed = new ProposedContentProvider();
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(ProposedContentProvider.scheme, proposed));

  let generating = 0;
  const setGenerating = (on: boolean) => {
    generating = Math.max(0, generating + (on ? 1 : -1));
    void vscode.commands.executeCommand("setContext", "forgelens.generating", generating > 0);
  };

  const panel = new AgentPanel(ctx, host, () => forge, () => settings, proposed, setGenerating);
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider(AgentPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }));
  const inline = new InlineEditController(host, () => forge, () => settings, (m) => panel.post(m), setGenerating);
  inline.register(ctx);

  // ---- MCP server + TrueForge registration -----------------------------------
  try {
    try {
      mcp = await startMcpHttp(host, settings.mcpPort, (m) => log.appendLine(m));
    } catch (e) {
      log.appendLine(`port ${settings.mcpPort} unavailable (${(e as Error).message}); using a random port`);
      mcp = await startMcpHttp(host, 0, (m) => log.appendLine(m));
    }
    log.appendLine(`editor MCP server listening on ${mcp.url}`);
  } catch (e) {
    vscode.window.showErrorMessage(`ForgeLens could not start its MCP server: ${(e as Error).message}`);
  }

  async function connect(interactive: boolean) {
    status.text = "$(sync~spin) ForgeLens";
    try {
      await forge.ping();
      if (!mcp) throw new Error("editor MCP server is not running");
      await forge.registerConnector(mcp.url, mcp.token);
      await forge.registerAgents(settings.models[0]).catch((e) => log.appendLine(`agent registry sync skipped: ${(e as Error).message}`));
      const available = await forge.listModels().catch(() => [] as string[]);
      const missing = settings.models.filter((m) => available.length && !available.includes(m));
      if (missing.length) vscode.window.showWarningMessage(`ForgeLens: these models are not configured in TrueForge: ${missing.join(", ")}. Add them under Settings → Models, or edit "forgelens.models".`);
      connected = true;
      status.text = `$(check) ForgeLens · ${shortModel(settings.models[0])}`;
      status.tooltip = `TrueForge ${settings.trueforgeUrl}\nModels (fallback order): ${settings.models.join(" → ")}\nMCP: ${mcp.url}\nClick to reconnect`;
      log.appendLine(`connected to TrueForge at ${settings.trueforgeUrl}`);
      if (interactive) vscode.window.showInformationMessage("ForgeLens connected to TrueForge.");
    } catch (e) {
      connected = false;
      status.text = "$(debug-disconnect) ForgeLens: TrueForge offline";
      status.tooltip = String((e as Error).message);
      log.appendLine(`connect failed: ${(e as Error).message}`);
      if (interactive) vscode.window.showErrorMessage((e as Error).message);
    }
  }
  void connect(false);

  // Before each run make sure TrueForge knows the current MCP token.
  const wrapRun = (f: ForgeClient) => {
    const run = f.run.bind(f);
    f.run = async (opts) => {
      if (!connected) await connect(false);
      if (!connected) throw new Error(`TrueForge is not reachable at ${settings.trueforgeUrl}. Start it with scripts/start-trueforge.ps1 (or .sh).`);
      return run(opts);
    };
  };
  wrapRun(forge);

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("forgelens")) return;
      settings = readSettings();
      forge = new ForgeClient(settings.trueforgeUrl, path.join(ctx.extensionPath, "agents"));
      wrapRun(forge);
      connected = false;
      void connect(false);
    }),
    vscode.commands.registerCommand("forgelens.reconnect", () => connect(true)),
    vscode.commands.registerCommand("forgelens.focusAgent", async () => {
      await vscode.commands.executeCommand(`${AgentPanel.viewId}.focus`);
      panel.post({ type: "focusInput" });
    }),
    vscode.commands.registerCommand("forgelens.cancel", () => {
      if (inline.running) inline.cancel();
      if (panel.running) panel.stop();
    }),
    vscode.commands.registerCommand("forgelens.openSession", () => panel.openSession()),
    vscode.commands.registerCommand("forgelens.undoLast", async () => {
      try {
        const rel = await host.undoLast();
        vscode.window.showInformationMessage(rel ? `ForgeLens: reverted the last change to ${rel}.` : "ForgeLens: nothing to undo.");
        if (rel) panel.notice("info", `↶ Undid the last applied change (${rel}).`);
      } catch (e) {
        vscode.window.showErrorMessage(`ForgeLens: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand("forgelens.revertRun", async () => {
      const runId = panel.lastRun;
      const changes = runId ? host.runChanges(runId) : [];
      if (!runId || !changes.length) return void vscode.window.showInformationMessage("ForgeLens: the last agent run has no applied changes.");
      const files = [...new Set(changes.map((c) => c.rel))];
      const ok = await vscode.window.showWarningMessage(`Revert ${changes.length} change(s) from the last agent run?\n${files.join("\n")}`, { modal: true }, "Revert");
      if (ok !== "Revert") return;
      try {
        const done = await host.revertRun(runId);
        vscode.window.showInformationMessage(`ForgeLens: reverted ${done.length} change(s).`);
        panel.notice("info", `↶ Reverted the last run: ${[...new Set(done)].join(", ")}`);
      } catch (e) {
        vscode.window.showErrorMessage(`ForgeLens: ${(e as Error).message}`);
      }
    }),
    { dispose: () => void mcp?.close() }
  );
}

export async function deactivate() {
  await mcp?.close();
}

function shortModel(m?: string) {
  return (m ?? "no model").split("/").pop();
}

function debounceByKey(fn: (k: string) => void, ms: number) {
  const timers = new Map<string, NodeJS.Timeout>();
  return (k: string) => {
    clearTimeout(timers.get(k));
    timers.set(k, setTimeout(() => (timers.delete(k), fn(k)), ms));
  };
}

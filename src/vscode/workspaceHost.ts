// VS Code implementation of the MCP EditorHost: live buffers, atomic writes,
// checkpoints for undo, and the bridge from approvals to applied hunks.
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { EditorHost, ToolActivity } from "../core/mcpServer";
import { RepoIndex } from "../core/repoIndex";
import { ApprovalBook, finalizeApprovedEdit } from "../core/review";
import { runCommand } from "../core/commands";

export interface Checkpoint {
  id: number;
  runId: string;
  rel: string;
  before: string | null; // null = file did not exist
  after: string;
  label: string;
  at: number;
}

export class WorkspaceHost implements EditorHost {
  index: RepoIndex;
  book = new ApprovalBook();
  checkpoints: Checkpoint[] = [];
  currentRunId = "manual";
  private nextId = 1;
  activityListeners: ((a: ToolActivity) => void)[] = [];
  commandApprovals = new Set<string>(); // toolCallKey-ish: command strings approved for the current pause
  private abort?: AbortController;

  constructor(public root: string, private log: vscode.OutputChannel) {
    this.index = new RepoIndex(root, (rel) => this.openBufferText(rel));
  }

  /** Text of an open editor buffer (may contain unsaved changes). */
  private openBufferText(rel: string): string | undefined {
    const abs = path.join(this.root, rel);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && path.normalize(d.uri.fsPath).toLowerCase() === path.normalize(abs).toLowerCase());
    return doc?.getText();
  }

  readFile(rel: string): string | undefined {
    const live = this.openBufferText(rel);
    if (live !== undefined) return live;
    try {
      return fs.readFileSync(path.join(this.root, rel), "utf8");
    } catch {
      return undefined;
    }
  }

  onActivity(a: ToolActivity) {
    for (const l of this.activityListeners) l(a);
  }

  async applyApprovedEdit(tool: "propose_edit" | "propose_new_file", args: Record<string, unknown>): Promise<string> {
    const r = finalizeApprovedEdit(this.book, (rel) => this.readFile(rel), tool, args);
    await this.writeAtomic(r.rel, r.after, r.isNew);
    this.checkpoints.push({ id: this.nextId++, runId: this.currentRunId, rel: r.rel, before: r.before, after: r.after, label: `${tool} ${r.rel}`, at: Date.now() });
    this.index.update(r.rel);
    return r.message;
  }

  async runApprovedCommand(args: { command: string; reason?: string }): Promise<string> {
    if (!this.commandApprovals.delete(args.command.trim())) return "REFUSED: this command was not approved by the user.";
    this.abort = new AbortController();
    const r = await runCommand(this.root, args.command, { signal: this.abort.signal });
    this.log.appendLine(`$ ${args.command} -> exit ${r.exitCode}`);
    return `$ ${args.command}\nexit code: ${r.exitCode}${r.timedOut ? " (timed out after 120s)" : ""}\n${r.output}`;
  }

  killCommands() {
    this.abort?.abort();
  }

  /**
   * One WorkspaceEdit per file = one atomic, undoable step (Ctrl+Z in the editor
   * restores it). The document is saved so tests see the change, and the buffer
   * and disk never disagree.
   */
  async writeAtomic(rel: string, text: string, isNew: boolean) {
    const uri = vscode.Uri.file(path.join(this.root, rel));
    const we = new vscode.WorkspaceEdit();
    if (isNew) {
      we.createFile(uri, { ignoreIfExists: false, contents: Buffer.from(text, "utf8") });
      if (!(await vscode.workspace.applyEdit(we))) throw new Error(`could not create ${rel}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    we.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
    if (!(await vscode.workspace.applyEdit(we))) throw new Error(`could not apply edit to ${rel}`);
    await doc.save();
  }

  async deleteFile(rel: string) {
    const we = new vscode.WorkspaceEdit();
    we.deleteFile(vscode.Uri.file(path.join(this.root, rel)), { ignoreIfNotExists: true });
    await vscode.workspace.applyEdit(we);
  }

  /** Restore one checkpoint. Refuses if the file was changed since (to avoid clobbering user work). */
  async revert(cp: Checkpoint, force = false): Promise<string> {
    const cur = this.readFile(cp.rel);
    if (!force && cur !== undefined && cur.replace(/\r\n/g, "\n") !== cp.after.replace(/\r\n/g, "\n")) {
      throw new Error(`${cp.rel} was modified after ForgeLens changed it; not reverting automatically.`);
    }
    if (cp.before === null) await this.deleteFile(cp.rel);
    else await this.writeAtomic(cp.rel, cp.before, false);
    this.checkpoints = this.checkpoints.filter((c) => c.id !== cp.id);
    this.index.update(cp.rel);
    return cp.rel;
  }

  async undoLast(): Promise<string | undefined> {
    const cp = this.checkpoints[this.checkpoints.length - 1];
    if (!cp) return undefined;
    return this.revert(cp);
  }

  async revertRun(runId: string): Promise<string[]> {
    const cps = this.checkpoints.filter((c) => c.runId === runId).reverse();
    const done: string[] = [];
    for (const cp of cps) done.push(await this.revert(cp));
    return done;
  }

  runChanges(runId: string) {
    return this.checkpoints.filter((c) => c.runId === runId);
  }
}

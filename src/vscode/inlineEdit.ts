// Inline edit: select code, Ctrl+Alt+K, type an instruction. The rewrite streams
// from TrueForge, then is shown IN the editor as a per-hunk diff (removed lines
// red, proposed lines green, CodeLens "Accept | Reject" on every hunk).
//
// Safety: the file on disk is never written while hunks are pending. If the user
// saves mid-review, pending hunks are reverted for that save (waitUntil), so a
// half-reviewed state can never reach disk. Every step is a normal editor edit,
// so Ctrl+Z works, and the final result is recorded as a ForgeLens checkpoint.
import * as vscode from "vscode";
import * as path from "path";
import { ForgeClient } from "../core/forgeClient";
import { computeSegments, Segment } from "../core/hunks";
import { WorkspaceHost } from "./workspaceHost";
import { Settings } from "./settings";

type HunkState = "pending" | "accepted" | "rejected";

interface Rendered {
  lines: string[];
  del: number[]; // 0-based offsets within block
  add: number[];
  hunkStarts: { index: number; offset: number }[];
}

const delDeco = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
  textDecoration: "line-through",
  overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.deletedForeground"),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});
const addDeco = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
  overviewRulerColor: new vscode.ThemeColor("editorOverviewRuler.addedForeground"),
  overviewRulerLane: vscode.OverviewRulerLane.Left,
});
const busyDeco = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor("editor.findRangeHighlightBackground"),
});

export class InlineSession {
  static active = new Map<string, InlineSession>(); // doc uri -> session
  private states = new Map<number, HunkState>();
  private lineCount: number;
  private applying = false;
  readonly beforeDoc: string;
  private wasDirty: boolean;

  constructor(
    public doc: vscode.TextDocument,
    public startLine: number,
    private segs: Segment[],
    origLineCount: number,
    private host: WorkspaceHost,
    private settings: Settings,
    private onChange: () => void
  ) {
    for (const s of segs) if (s.kind === "hunk") this.states.set(s.index, "pending");
    this.lineCount = origLineCount;
    this.beforeDoc = doc.getText();
    this.wasDirty = doc.isDirty;
  }

  get key() {
    return this.doc.uri.toString();
  }
  get pendingCount() {
    return [...this.states.values()].filter((s) => s === "pending").length;
  }
  get total() {
    return this.states.size;
  }
  get isApplying() {
    return this.applying;
  }

  render(): Rendered {
    const r: Rendered = { lines: [], del: [], add: [], hunkStarts: [] };
    for (const s of this.segs) {
      if (s.kind === "same") {
        r.lines.push(...s.lines);
        continue;
      }
      const st = this.states.get(s.index)!;
      if (st === "pending") {
        r.hunkStarts.push({ index: s.index, offset: r.lines.length });
        for (const l of s.oldLines) (r.del.push(r.lines.length), r.lines.push(l));
        for (const l of s.newLines) (r.add.push(r.lines.length), r.lines.push(l));
      } else r.lines.push(...(st === "accepted" ? s.newLines : s.oldLines));
    }
    return r;
  }

  /** Text the block should contain if every pending hunk were rejected. */
  private settledText(rejectPending: boolean): string[] {
    const lines: string[] = [];
    for (const s of this.segs) {
      if (s.kind === "same") lines.push(...s.lines);
      else {
        const st = this.states.get(s.index)!;
        lines.push(...(st === "accepted" ? s.newLines : st === "rejected" || rejectPending ? s.oldLines : s.newLines));
      }
    }
    return lines;
  }

  blockRange(): vscode.Range {
    const end = this.startLine + this.lineCount;
    if (end >= this.doc.lineCount) return new vscode.Range(this.startLine, 0, this.doc.lineCount - 1, this.doc.lineAt(this.doc.lineCount - 1).text.length);
    return new vscode.Range(this.startLine, 0, end, 0);
  }

  async apply(): Promise<void> {
    const r = this.render();
    const range = this.blockRange();
    const trailing = range.end.character === 0 && range.end.line > range.start.line ? "\n" : "";
    const editor = await vscode.window.showTextDocument(this.doc, { preserveFocus: false, preview: false });
    this.applying = true;
    try {
      const ok = await editor.edit((b) => b.replace(range, r.lines.join("\n") + trailing), { undoStopBefore: true, undoStopAfter: true });
      if (!ok) throw new Error("the editor rejected the edit");
    } finally {
      this.applying = false;
    }
    this.lineCount = r.lines.length;
    this.decorate(editor, r);
    if (this.pendingCount === 0) await this.finish();
    this.onChange();
  }

  decorate(editor: vscode.TextEditor, r = this.render()) {
    const toRanges = (offs: number[]) => offs.map((o) => new vscode.Range(this.startLine + o, 0, this.startLine + o, 0));
    editor.setDecorations(delDeco, toRanges(r.del));
    editor.setDecorations(addDeco, toRanges(r.add));
  }

  lenses(): vscode.CodeLens[] {
    const r = this.render();
    const out: vscode.CodeLens[] = [];
    if (!r.hunkStarts.length) return out;
    const top = new vscode.Range(this.startLine, 0, this.startLine, 0);
    out.push(new vscode.CodeLens(top, { title: `ForgeLens: ${this.pendingCount}/${this.total} hunk(s) to review`, command: "" }));
    out.push(new vscode.CodeLens(top, { title: "✓ Accept all (Ctrl+Shift+Enter)", command: "forgelens.acceptAll" }));
    out.push(new vscode.CodeLens(top, { title: "✗ Reject all (Ctrl+Shift+Backspace)", command: "forgelens.rejectAll" }));
    r.hunkStarts.forEach((h, i) => {
      const pos = new vscode.Range(this.startLine + h.offset, 0, this.startLine + h.offset, 0);
      out.push(new vscode.CodeLens(pos, { title: `✓ Accept hunk ${i + 1}`, command: "forgelens.inlineHunk", arguments: [this.key, h.index, true] }));
      out.push(new vscode.CodeLens(pos, { title: `✗ Reject hunk ${i + 1}`, command: "forgelens.inlineHunk", arguments: [this.key, h.index, false] }));
    });
    return out;
  }

  async resolve(index: number | "all", accept: boolean) {
    for (const [i, st] of this.states) if (st === "pending" && (index === "all" || index === i)) this.states.set(i, accept ? "accepted" : "rejected");
    await this.apply();
  }

  /** onWillSave: never let a half-reviewed block reach disk. */
  pendingRevertEdit(): vscode.TextEdit[] {
    if (!this.pendingCount) return [];
    const lines = this.settledText(true);
    const range = this.blockRange();
    const trailing = range.end.character === 0 && range.end.line > range.start.line ? "\n" : "";
    for (const [i, st] of this.states) if (st === "pending") this.states.set(i, "rejected");
    this.lineCount = lines.length;
    setTimeout(() => void this.finish(true), 0); // the save in progress persists the result
    return [vscode.TextEdit.replace(range, lines.join("\n") + trailing)];
  }

  /** External edit: keep the block anchored, or bail out if the user typed inside it. */
  onExternalChange(e: vscode.TextDocumentChangeEvent): boolean {
    for (const c of e.contentChanges) {
      const delta = c.text.split("\n").length - 1 - (c.range.end.line - c.range.start.line);
      if (c.range.end.line < this.startLine) this.startLine += delta;
      else if (c.range.start.line >= this.startLine + this.lineCount) continue;
      else return false; // edited inside the block
    }
    return true;
  }

  async finish(skipSave = false) {
    if (!InlineSession.active.has(this.key)) return;
    if (skipSave) this.wasDirty = true;
    InlineSession.active.delete(this.key);
    for (const ed of vscode.window.visibleTextEditors) if (ed.document === this.doc) (ed.setDecorations(delDeco, []), ed.setDecorations(addDeco, []));
    void vscode.commands.executeCommand("setContext", "forgelens.inlineReview", InlineSession.active.size > 0);
    const after = this.doc.getText();
    const accepted = [...this.states.values()].filter((s) => s === "accepted").length;
    if (after !== this.beforeDoc && accepted > 0) {
      const rel = path.relative(this.host.root, this.doc.uri.fsPath).split(path.sep).join("/");
      this.host.checkpoints.push({ id: Date.now(), runId: "inline", rel, before: this.beforeDoc, after, label: `inline edit ${rel}`, at: Date.now() });
      if (this.settings.saveOnAccept && !this.wasDirty) await this.doc.save();
      vscode.window.setStatusBarMessage(`ForgeLens: applied ${accepted}/${this.total} hunk(s). Ctrl+Z or "ForgeLens: Undo Last Applied Change" to undo.`, 6000);
    } else {
      if (this.settings.saveOnAccept && !this.wasDirty && this.doc.isDirty) await this.doc.save();
      vscode.window.setStatusBarMessage("ForgeLens: all hunks rejected — file unchanged.", 5000);
    }
    this.onChange();
  }
}

export class InlineEditController implements vscode.CodeLensProvider {
  private lensEmitter = new vscode.EventEmitter<void>();
  onDidChangeCodeLenses = this.lensEmitter.event;
  private abort?: AbortController;

  constructor(
    private host: WorkspaceHost,
    private forge: () => ForgeClient,
    private settings: () => Settings,
    private panelPost: (m: unknown) => void,
    private setGenerating: (on: boolean, who: "agent" | "inline") => void
  ) {}

  register(ctx: vscode.ExtensionContext) {
    ctx.subscriptions.push(
      vscode.languages.registerCodeLensProvider({ scheme: "file" }, this),
      vscode.commands.registerCommand("forgelens.inlineEdit", () => this.start()),
      vscode.commands.registerCommand("forgelens.inlineHunk", (key: string, index: number, accept: boolean) => InlineSession.active.get(key)?.resolve(index, accept)),
      vscode.commands.registerCommand("forgelens.acceptAll", () => this.current()?.resolve("all", true)),
      vscode.commands.registerCommand("forgelens.rejectAll", () => this.current()?.resolve("all", false)),
      vscode.workspace.onWillSaveTextDocument((e) => {
        const s = InlineSession.active.get(e.document.uri.toString());
        if (s && s.pendingCount) {
          vscode.window.showWarningMessage("ForgeLens: unreviewed hunks were rejected before saving, so only reviewed changes reach disk.");
          e.waitUntil(Promise.resolve(s.pendingRevertEdit()));
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const s = InlineSession.active.get(e.document.uri.toString());
        if (!s || s.isApplying || !e.contentChanges.length) return;
        if (!s.onExternalChange(e)) {
          InlineSession.active.delete(s.key);
          void vscode.commands.executeCommand("setContext", "forgelens.inlineReview", InlineSession.active.size > 0);
          for (const ed of vscode.window.visibleTextEditors) if (ed.document === e.document) (ed.setDecorations(delDeco, []), ed.setDecorations(addDeco, []));
          vscode.window.showWarningMessage("ForgeLens: you edited inside the review block, so the inline review was closed. Use Ctrl+Z to step back if needed.");
        }
        this.lensEmitter.fire();
      }),
      vscode.window.onDidChangeVisibleTextEditors((eds) => {
        for (const ed of eds) InlineSession.active.get(ed.document.uri.toString())?.decorate(ed);
      })
    );
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    return InlineSession.active.get(doc.uri.toString())?.lenses() ?? [];
  }

  private current(): InlineSession | undefined {
    const ed = vscode.window.activeTextEditor;
    return ed ? InlineSession.active.get(ed.document.uri.toString()) : undefined;
  }

  cancel() {
    this.abort?.abort();
  }

  get running() {
    return !!this.abort;
  }

  async start() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (this.abort) return void vscode.window.showWarningMessage("ForgeLens is already generating an inline edit (Esc to cancel).");
    const doc = editor.document;
    if (InlineSession.active.has(doc.uri.toString())) return void vscode.window.showWarningMessage("Resolve the pending ForgeLens hunks in this file first.");
    if (doc.uri.scheme !== "file") return void vscode.window.showWarningMessage("ForgeLens inline edit works on files in the workspace.");

    // Expand the selection to whole lines; no selection = the current line.
    const sel = editor.selection;
    const startLine = sel.start.line;
    let endLine = sel.end.line;
    if (sel.end.character === 0 && endLine > startLine) endLine--;
    const selLines: string[] = [];
    for (let l = startLine; l <= endLine; l++) selLines.push(doc.lineAt(l).text);
    const selectionText = selLines.join("\n");
    if (!selectionText.trim()) return void vscode.window.showWarningMessage("Select the code you want to change first.");

    const instruction = await vscode.window.showInputBox({ title: "ForgeLens inline edit", prompt: `Lines ${startLine + 1}-${endLine + 1} of ${path.basename(doc.fileName)}`, placeHolder: "Describe the change, e.g. 'treat off and n as false'", ignoreFocusOut: true });
    if (!instruction?.trim()) return;

    const rel = path.relative(this.host.root, doc.uri.fsPath).split(path.sep).join("/");
    const before = [];
    for (let l = Math.max(0, startLine - 60); l < startLine; l++) before.push(doc.lineAt(l).text);
    const after = [];
    for (let l = endLine + 1; l < Math.min(doc.lineCount, endLine + 41); l++) after.push(doc.lineAt(l).text);
    const lang = doc.languageId;
    const input = [
      `File: ${rel} (${lang})`,
      `Instruction: ${instruction.trim()}`,
      "",
      `Code BEFORE the selection (context only, do not output):\n\`\`\`${lang}\n${before.join("\n")}\n\`\`\``,
      `SELECTION (lines ${startLine + 1}-${endLine + 1}) — rewrite this:\n\`\`\`${lang}\n${selectionText}\n\`\`\``,
      `Code AFTER the selection (context only, do not output):\n\`\`\`${lang}\n${after.join("\n")}\n\`\`\``,
      "",
      "Return only the rewritten SELECTION in one fenced code block.",
    ].join("\n");

    const s = this.settings();
    const ac = (this.abort = new AbortController());
    this.setGenerating(true, "inline");
    const range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
    editor.setDecorations(busyDeco, [range]);
    this.panelPost({ type: "user", text: `Inline edit · ${rel}:${startLine + 1}-${endLine + 1}\n${instruction.trim()}` });

    let streamed = "";
    let lastModel = s.models[0];
    let result: Awaited<ReturnType<ForgeClient["run"]>> | undefined;
    try {
      result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "ForgeLens", cancellable: true },
        async (progress, token) => {
          token.onCancellationRequested(() => ac.abort());
          progress.report({ message: `connecting to TrueForge (${lastModel})…` });
          return this.forge().run({
            kind: "inline",
            models: s.models,
            input,
            retries: s.retries,
            signal: ac.signal,
            title: `Inline: ${instruction.slice(0, 60)}`,
            cb: {
              onStatus: (st) => {
                lastModel = st.model;
                this.panelPost({ type: "status", ...st });
                if (st.phase === "retrying") progress.report({ message: `⚠ ${st.message}` });
                if (st.phase === "fallback") {
                  progress.report({ message: `⇄ ${st.message}` });
                  vscode.window.showWarningMessage(`ForgeLens: ${st.message}`);
                }
                if (st.phase === "running") progress.report({ message: `streaming from ${st.model}…` });
              },
              onDelta: (threadId, id, chunk, kind) => {
                this.panelPost({ type: "delta", threadId, id, chunk, kind });
                if (kind !== "content") return;
                streamed += chunk;
                const lastLine = streamed.trimEnd().split("\n").pop() ?? "";
                progress.report({ message: `${lastModel} · ${streamed.length} chars · ${lastLine.trim().slice(0, 70)}` });
              },
            },
          });
        }
      );
    } catch (e) {
      result = { sessionId: "", status: "error", output: "", model: lastModel, error: (e as Error).message, fellBack: false };
    } finally {
      this.abort = undefined;
      this.setGenerating(false, "inline");
      editor.setDecorations(busyDeco, []);
    }

    this.panelPost({ type: "done", status: result.status, error: result.error, model: result.model, fellBack: result.fellBack, changes: [] });
    if (result.status === "cancelled") return void vscode.window.showInformationMessage("ForgeLens: inline edit cancelled. The file was not changed.");
    if (result.status === "error") return void vscode.window.showErrorMessage(`ForgeLens could not complete the edit. Your file was not changed.\n${result.error ?? ""}`, { modal: false });

    const proposal = extractCode(result.output || streamed);
    if (proposal === undefined) return void vscode.window.showWarningMessage("ForgeLens: the model did not return code. Nothing was changed.");
    if (doc.version !== undefined && editor.document !== doc) return;
    // If the user edited the selection while we were generating, don't clobber it.
    const nowSel: string[] = [];
    for (let l = startLine; l <= endLine && l < doc.lineCount; l++) nowSel.push(doc.lineAt(l).text);
    if (nowSel.join("\n") !== selectionText) return void vscode.window.showWarningMessage("ForgeLens: the selection changed while generating; discarding the proposal.");

    const newText = reindent(proposal, selLines);
    const segs = computeSegments(selectionText + "\n", newText + "\n");
    if (!segs.some((x) => x.kind === "hunk")) return void vscode.window.showInformationMessage("ForgeLens: the model proposed no change.");
    const session = new InlineSession(doc, startLine, segs, selLines.length, this.host, s, () => this.lensEmitter.fire());
    InlineSession.active.set(session.key, session);
    void vscode.commands.executeCommand("setContext", "forgelens.inlineReview", true);
    await session.apply();
    vscode.window.setStatusBarMessage(`ForgeLens: review ${session.total} hunk(s) — Accept/Reject above each hunk`, 8000);
  }
}

/** Pull the code out of a fenced block (or use the raw text if the model skipped the fence). */
export function extractCode(out: string): string | undefined {
  const m = /```[\w+-]*[^\n]*\n([\s\S]*?)```/.exec(out);
  let code = m ? m[1] : out.includes("```") ? out.replace(/```[\w+-]*\n?/g, "") : out;
  code = code.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  return code.trim() ? code : undefined;
}

/** If the model dropped the selection's base indentation, put it back. */
export function reindent(code: string, original: string[]): string {
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const firstOrig = original.find((l) => l.trim());
  const firstNew = code.split("\n").find((l) => l.trim());
  if (!firstOrig || !firstNew) return code;
  const want = indentOf(firstOrig);
  const have = indentOf(firstNew);
  if (want === have) return code;
  const pad = firstOrig.slice(0, want);
  if (have === 0 && want > 0) return code.split("\n").map((l) => (l.trim() ? pad + l : l)).join("\n");
  return code;
}

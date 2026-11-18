// Read-only virtual documents holding proposed file contents, so a proposal can be
// previewed in VS Code's native diff editor without ever being written to disk.
import * as vscode from "vscode";

export class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = "forgelens-proposed";
  private contents = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  onDidChange = this.emitter.event;

  uriFor(id: string, relPath: string) {
    return vscode.Uri.parse(`${ProposedContentProvider.scheme}:/${id}/${relPath}`);
  }

  set(id: string, text: string) {
    this.contents.set(id, text);
    for (const d of vscode.workspace.textDocuments) if (d.uri.scheme === ProposedContentProvider.scheme && d.uri.path.startsWith(`/${id}/`)) this.emitter.fire(d.uri);
  }

  delete(id: string) {
    this.contents.delete(id);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.path.startsWith("/empty/")) return "";
    const id = uri.path.split("/")[1];
    return this.contents.get(id) ?? "(this proposal is no longer pending)";
  }
}

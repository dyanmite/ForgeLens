import * as vscode from "vscode";

export interface Settings {
  trueforgeUrl: string;
  models: string[];
  retries: number;
  contextBudget: number;
  mcpPort: number;
  saveOnAccept: boolean;
}

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration("forgelens");
  return {
    trueforgeUrl: (c.get<string>("trueforgeUrl") ?? "http://localhost:8790").replace(/\/$/, ""),
    models: (c.get<string[]>("models") ?? []).map((m) => m.trim()).filter(Boolean),
    retries: Math.max(0, Math.min(5, c.get<number>("retriesPerModel") ?? 2)),
    contextBudget: Math.max(1000, Math.min(60000, c.get<number>("contextBudgetTokens") ?? 6000)),
    mcpPort: c.get<number>("mcpPort") ?? 7391,
    saveOnAccept: c.get<boolean>("saveOnAccept") ?? true,
  };
}

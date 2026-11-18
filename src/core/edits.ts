// Turning a model's edit request into a validated proposal.
//
// Guards (each one targets a failure the challenge brief calls out):
//   * Anchor guard     - every old_text must match the CURRENT file exactly once.
//                        A model that "confidently edits a symbol that does not exist"
//                        is stopped here and told to re-read the file.
//   * Stale guard      - the match is checked against the live buffer, so an edit
//                        based on an outdated read can never be applied.
//   * Syntax guard     - Python proposals are parsed (ast.parse) before the user
//                        ever sees them; broken code is bounced back to the model.
//   * Symbol guard     - new `from x import y` lines are checked against the repo
//                        index; unresolved names are flagged on the hunk.
import { spawnSync } from "child_process";
import { RepoIndex } from "./repoIndex";

export interface EditOp {
  old_text: string;
  new_text: string;
}

export interface Proposal {
  path: string;
  isNew: boolean;
  before: string; // "\n" line endings
  after: string;
  eol: "\n" | "\r\n";
  warnings: string[];
}

export class EditRejected extends Error {}

export function detectEol(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export const toLf = (s: string) => s.replace(/\r\n/g, "\n");

function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let n = 0,
    i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

/** Strip accidental "  12 | " line-number gutters some models copy from read_file output. */
function stripGutter(s: string): string {
  const lines = s.split("\n");
  if (lines.length && lines.every((l) => /^\s*\d+\s?[|:]\s?/.test(l) || l === "")) return lines.map((l) => l.replace(/^\s*\d+\s?[|:]\s?/, "")).join("\n");
  return s;
}

export function applyEditOps(path: string, current: string, ops: EditOp[]): string {
  if (!Array.isArray(ops) || ops.length === 0) throw new EditRejected("edits must be a non-empty array of {old_text, new_text}");
  let text = current;
  ops.forEach((op, i) => {
    if (typeof op?.old_text !== "string" || typeof op?.new_text !== "string") throw new EditRejected(`edit #${i + 1}: old_text and new_text must be strings`);
    let oldT = toLf(op.old_text);
    const newT = toLf(op.new_text);
    if (oldT === "") throw new EditRejected(`edit #${i + 1}: old_text is empty. To create a file use propose_new_file; to append, anchor on the last lines of the file.`);
    let n = countOccurrences(text, oldT);
    if (n === 0) {
      const g = stripGutter(oldT);
      if (g !== oldT && countOccurrences(text, g) === 1) {
        oldT = g;
        n = 1;
      }
    }
    if (n === 0) {
      throw new EditRejected(
        `edit #${i + 1}: old_text was not found in ${path}. The code you are trying to change does not exist in the current file (it may have changed, or never existed). Call read_file on ${path} and copy old_text exactly.`
      );
    }
    if (n > 1) throw new EditRejected(`edit #${i + 1}: old_text matches ${n} places in ${path}; include more surrounding lines so it is unique.`);
    text = text.replace(oldT, () => newT);
  });
  if (text === current) throw new EditRejected("the edits produce no change");
  return text;
}

export function pythonSyntaxError(source: string, pythonCmd: string): string | null {
  const script = "import ast,sys\ntry:\n ast.parse(sys.stdin.read())\nexcept SyntaxError as e:\n print(f'line {e.lineno}: {e.msg}')\n";
  const r = spawnSync(pythonCmd, ["-c", script], { input: source, encoding: "utf8", timeout: 10000, windowsHide: true });
  if (r.error) return null; // no python available: skip the check rather than block
  const out = (r.stdout || "").trim();
  return out ? out : null;
}

/** Flag `from pkg.mod import a, b` lines whose module/names are not in the repo index. */
export function unresolvedImports(index: RepoIndex, filePath: string, before: string, after: string): string[] {
  const added = new Set(after.split("\n").filter((l) => !before.includes(l)));
  const warnings: string[] = [];
  const pkgDir = filePath.split("/").slice(0, -1).join("/");
  for (const line of added) {
    const m = /^\s*from\s+(\.*[A-Za-z0-9_.]*)\s+import\s+\(?([A-Za-z0-9_,\s]+)\)?/.exec(line);
    if (!m) continue;
    const mod = m[1];
    let modPath: string | undefined;
    if (mod.startsWith(".")) {
      const dots = mod.match(/^\.+/)![0].length;
      const base = pkgDir.split("/").slice(0, pkgDir.split("/").length - (dots - 1));
      const restParts = mod.slice(dots).split(".").filter(Boolean);
      modPath = [...base, ...restParts].join("/");
    } else {
      const parts = mod.split(".");
      // only check modules that live in this repository (e.g. src/flask/...)
      const cand = [...index.files.keys()].find((p) => p.endsWith(`/${parts.join("/")}.py`) || p.endsWith(`/${parts.join("/")}/__init__.py`));
      if (!cand) continue;
      modPath = cand.replace(/\.py$/, "").replace(/\/__init__$/, "");
    }
    const file = index.files.get(`${modPath}.py`) ?? index.files.get(`${modPath}/__init__.py`);
    if (!file) {
      if (mod.startsWith(".")) warnings.push(`import from ${mod}: module not found in repository`);
      continue;
    }
    const text = index.getText(file.path) ?? "";
    for (const name of m[2].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
      const defined = file.symbols.some((s) => s.name === name) || new RegExp(`(^|\\n)\\s*(from .* import .*\\b${name}\\b|import .*\\b${name}\\b|${name}\\s*[:=])`).test(text);
      if (!defined) warnings.push(`'${name}' is imported from ${mod} but is not defined there`);
    }
  }
  return warnings;
}

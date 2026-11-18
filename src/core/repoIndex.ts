// Repository index: files, symbols and retrieval chunks.
//
// The index is what lets the agent work on a repository far larger than its
// context window. It powers:
//   * repo_map      - a compact, ranked outline (files + top-level symbols)
//   * find_symbol   - exact/fuzzy symbol lookup -> file:line
//   * search_code   - literal/regex search over indexed text
//   * context packs - BM25 retrieval over symbol-sized chunks under a token budget
import * as fs from "fs";
import * as path from "path";
import { isDenied } from "./security";

export interface SymbolInfo {
  name: string; // simple name, e.g. "get_debug_flag"
  qualname: string; // e.g. "FlaskGroup.list_commands"
  kind: "function" | "class" | "method" | "section" | "variable";
  path: string; // workspace-relative POSIX
  line: number; // 1-based
  endLine: number; // 1-based inclusive
}

export interface Chunk {
  id: number;
  path: string;
  startLine: number;
  endLine: number;
  title: string; // symbol qualname or section title
  tokens: number; // estimated
  terms: Map<string, number>;
  len: number;
}

export interface FileInfo {
  path: string;
  lines: number;
  tokens: number;
  symbols: SymbolInfo[];
}

const INDEX_EXT = new Set([".py", ".pyi", ".rst", ".md", ".txt", ".toml", ".cfg", ".ini", ".js", ".ts", ".tsx", ".jsx", ".json", ".html", ".yaml", ".yml", ".css"]);
const MAX_FILE_BYTES = 512 * 1024;

export const estimateTokens = (s: string) => Math.ceil(s.length / 3.6);

const STOP = new Set(
  "a an and are as at be been by can do for from has have if in into is it its of on or that the their then there these this to was were will with without you your must should also any every new add make use using all not only as its value values".split(" ")
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  // split camelCase and snake_case, keep alphanumerics
  const words = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/);
  for (const w of words) {
    if (w.length < 2 || STOP.has(w)) continue;
    out.push(w);
    // crude stemming so "commands" matches "command", "masked" matches "mask"
    if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) out.push(w.slice(0, -1));
    else if (w.length > 5 && w.endsWith("ed")) out.push(w.slice(0, -2));
    else if (w.length > 6 && w.endsWith("ing")) out.push(w.slice(0, -3));
  }
  return out;
}

export class RepoIndex {
  files = new Map<string, FileInfo>();
  chunks: Chunk[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  private texts = new Map<string, string>();

  constructor(public root: string, private readText?: (rel: string) => string | undefined) {}

  build(): this {
    this.files.clear();
    this.chunks = [];
    this.df.clear();
    this.texts.clear();
    this.walk(this.root);
    this.finish();
    return this;
  }

  /** Re-index a single file after it changed (cheap; df recomputed). */
  update(rel: string) {
    this.chunks = this.chunks.filter((c) => c.path !== rel);
    this.files.delete(rel);
    this.texts.delete(rel);
    const abs = path.join(this.root, rel);
    if (fs.existsSync(abs)) this.addFile(rel);
    this.finish();
  }

  getText(rel: string): string | undefined {
    const live = this.readText?.(rel);
    if (live !== undefined) return live;
    return this.texts.get(rel);
  }

  private walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(this.root, abs).split(path.sep).join("/");
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      if (isDenied(rel)) continue;
      if (e.isDirectory()) {
        if (["dist", "build", "out", "htmlcov", ".eggs"].includes(e.name) || e.name.endsWith(".egg-info")) continue;
        this.walk(abs);
      } else if (e.isFile() && INDEX_EXT.has(path.extname(e.name).toLowerCase())) {
        this.addFile(rel);
      }
    }
  }

  private addFile(rel: string) {
    const abs = path.join(this.root, rel);
    let text: string;
    try {
      const st = fs.statSync(abs);
      if (st.size > MAX_FILE_BYTES) return;
      text = this.readText?.(rel) ?? fs.readFileSync(abs, "utf8");
    } catch {
      return;
    }
    text = text.replace(/\r\n/g, "\n");
    this.texts.set(rel, text);
    const lines = text.split("\n");
    const ext = path.extname(rel).toLowerCase();
    const symbols = ext === ".py" || ext === ".pyi" ? parsePythonSymbols(rel, lines) : ext === ".rst" || ext === ".md" ? parseDocSections(rel, lines, ext) : [];
    this.files.set(rel, { path: rel, lines: lines.length, tokens: estimateTokens(text), symbols });
    this.makeChunks(rel, lines, symbols);
  }

  private makeChunks(rel: string, lines: string[], symbols: SymbolInfo[]) {
    // Top-level symbols (and doc sections) become chunks; the gaps between
    // them (imports, module docstrings, constants) become "header" chunks.
    const tops = symbols.filter((s) => s.kind !== "method").sort((a, b) => a.line - b.line);
    const spans: { start: number; end: number; title: string }[] = [];
    let cursor = 1;
    for (const s of tops) {
      if (s.line > cursor) spans.push({ start: cursor, end: s.line - 1, title: `${rel} (module code)` });
      spans.push({ start: s.line, end: s.endLine, title: s.qualname });
      cursor = Math.max(cursor, s.endLine + 1);
    }
    if (cursor <= lines.length) spans.push({ start: cursor, end: lines.length, title: tops.length ? `${rel} (module code)` : rel });
    // Split very large spans (e.g. big classes) into ~120 line windows.
    for (const sp of spans) {
      for (let a = sp.start; a <= sp.end; a += 120) {
        const b = Math.min(sp.end, a + 119);
        const body = lines.slice(a - 1, b).join("\n");
        if (!body.trim()) continue;
        const terms = new Map<string, number>();
        // path & title terms are boosted: they are strong signals of relevance
        for (const t of [...tokenize(rel), ...tokenize(rel), ...tokenize(sp.title), ...tokenize(sp.title), ...tokenize(body)]) terms.set(t, (terms.get(t) ?? 0) + 1);
        let len = 0;
        terms.forEach((v) => (len += v));
        this.chunks.push({ id: this.chunks.length, path: rel, startLine: a, endLine: b, title: sp.title, tokens: estimateTokens(body), terms, len });
      }
    }
  }

  private finish() {
    this.df.clear();
    let total = 0;
    this.chunks.forEach((c, i) => {
      c.id = i;
      total += c.len;
      c.terms.forEach((_v, t) => this.df.set(t, (this.df.get(t) ?? 0) + 1));
    });
    this.avgLen = this.chunks.length ? total / this.chunks.length : 1;
  }

  /** BM25 scoring. Returns chunks with score and the query terms that matched. */
  rank(query: string, limit = 50): { chunk: Chunk; score: number; matched: string[] }[] {
    const q = [...new Set(tokenize(query))];
    const N = this.chunks.length || 1;
    const k1 = 1.2,
      b = 0.75;
    const res: { chunk: Chunk; score: number; matched: string[] }[] = [];
    for (const c of this.chunks) {
      let s = 0;
      const matched: string[] = [];
      for (const t of q) {
        const f = c.terms.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * c.len) / this.avgLen)));
        matched.push(t);
      }
      if (s > 0) res.push({ chunk: c, score: s * pathPrior(c.path), matched });
    }
    res.sort((x, y) => y.score - x.score);
    return res.slice(0, limit);
  }

  findSymbol(name: string, limit = 20): SymbolInfo[] {
    const n = name.trim().replace(/\(\)$/, "");
    const all: SymbolInfo[] = [];
    this.files.forEach((f) => all.push(...f.symbols));
    const exact = all.filter((s) => s.qualname === n || s.name === n || s.qualname.endsWith("." + n));
    if (exact.length) return exact.slice(0, limit);
    const low = n.toLowerCase();
    return all.filter((s) => s.qualname.toLowerCase().includes(low)).slice(0, limit);
  }

  /** Grep over indexed text. Literal by default; regex if isRegex. */
  search(pattern: string, opts: { isRegex?: boolean; glob?: string; maxResults?: number } = {}) {
    const max = opts.maxResults ?? 40;
    let re: RegExp;
    try {
      re = opts.isRegex ? new RegExp(pattern, "i") : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    } catch (e) {
      throw new Error(`invalid regex: ${(e as Error).message}`);
    }
    const globRe = opts.glob ? globToRegExp(opts.glob) : undefined;
    const hits: { path: string; line: number; text: string }[] = [];
    let total = 0;
    for (const [rel] of this.files) {
      if (globRe && !globRe.test(rel)) continue;
      const text = this.getText(rel);
      if (!text) continue;
      const lines = text.replace(/\r\n/g, "\n").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          total++;
          if (hits.length < max) hits.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
        }
      }
    }
    return { hits, total };
  }

  /** Ranked outline of the repository, trimmed to a token budget. */
  repoMap(query: string | undefined, budgetTokens = 1800): string {
    const fileScore = new Map<string, number>();
    if (query) for (const r of this.rank(query, 200)) fileScore.set(r.chunk.path, (fileScore.get(r.chunk.path) ?? 0) + r.score);
    const files = [...this.files.values()].sort((a, b) => (fileScore.get(b.path) ?? 0) - (fileScore.get(a.path) ?? 0) || a.path.localeCompare(b.path));
    const out: string[] = [];
    let used = 0;
    let omitted = 0;
    for (const f of files) {
      const tops = f.symbols.filter((s) => s.kind !== "method" && s.kind !== "variable").slice(0, 25);
      const line = `${f.path} (${f.lines} lines)` + (tops.length ? `: ${tops.map((s) => (s.kind === "section" ? `§${s.name}` : s.name)).join(", ")}` : "");
      const t = estimateTokens(line);
      if (used + t > budgetTokens) {
        omitted++;
        continue;
      }
      used += t;
      out.push(line);
    }
    if (omitted) out.push(`… ${omitted} more files omitted (budget ${budgetTokens} tokens). Use search_code / find_symbol to look further.`);
    return out.join("\n");
  }
}

/** Prior relevance of a path: history/boilerplate files are rarely what a change needs. */
export function pathPrior(p: string): number {
  const low = p.toLowerCase();
  if (/(^|\/)(changes|changelog|history|news|authors|license|contributing)[^/]*$/.test(low)) return 0.25;
  if (/(^|\/)(examples?|tutorial)\//.test(low)) return 0.6;
  return 1;
}

/**
 * Companion files of a source file: its test module and its documentation page.
 * src/flask/cli.py -> tests/test_cli.py, docs/cli.rst
 */
export function companionsOf(index: RepoIndex, srcPath: string): { path: string; why: string }[] {
  const stem = srcPath.split("/").pop()!.replace(/\.[^.]+$/, "");
  if (stem === "__init__" || srcPath.startsWith("tests/") || srcPath.startsWith("docs/")) return [];
  const out: { path: string; why: string }[] = [];
  for (const p of index.files.keys()) {
    const base = p.split("/").pop()!;
    if (/(^|\/)tests?\//.test(p) && (base === `test_${stem}.py` || base === `${stem}_test.py` || base === `${stem}.test.ts`)) out.push({ path: p, why: `tests for ${srcPath}` });
    else if (/(^|\/)docs?\//.test(p) && (base === `${stem}.rst` || base === `${stem}.md`)) out.push({ path: p, why: `documentation for ${srcPath}` });
  }
  return out;
}

export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // a bare "*.py" should match at any depth
  return new RegExp((g.includes("/") ? "^" : "(^|/)") + re + "$", "i");
}

export function parsePythonSymbols(rel: string, lines: string[]): SymbolInfo[] {
  const syms: SymbolInfo[] = [];
  const stack: { indent: number; sym: SymbolInfo }[] = [];
  const defRe = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const varRe = /^([A-Z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=/; // module-level constants / aliases
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    const indent = ln.length - ln.trimStart().length;
    // close symbols whose body ended
    if (!ln.trimStart().startsWith("#") && !ln.trimStart().startsWith("@")) {
      while (stack.length && indent <= stack[stack.length - 1].indent && i + 1 > stack[stack.length - 1].sym.line) {
        stack.pop();
      }
    }
    const m = defRe.exec(ln);
    if (m) {
      const parent = stack[stack.length - 1]?.sym;
      const kind: SymbolInfo["kind"] = m[2] === "class" ? "class" : parent && parent.kind === "class" ? "method" : "function";
      // decorators belong to the symbol
      let start = i + 1;
      while (start > 1 && lines[start - 2].trimStart().startsWith("@")) start--;
      const sym: SymbolInfo = { name: m[3], qualname: parent ? `${parent.qualname}.${m[3]}` : m[3], kind, path: rel, line: start, endLine: i + 1 };
      syms.push(sym);
      stack.push({ indent, sym });
      continue;
    }
    if (indent === 0) {
      const v = varRe.exec(ln);
      if (v) syms.push({ name: v[1], qualname: v[1], kind: "variable", path: rel, line: i + 1, endLine: i + 1 });
    }
  }
  // compute end lines: a symbol ends right before the next line with indent <= its own (non-blank, non-comment)
  const indentOf = (l: string) => l.length - l.trimStart().length;
  for (const s of syms) {
    if (s.kind === "variable") continue;
    let defLine = s.line - 1;
    while (defLine < lines.length && lines[defLine].trimStart().startsWith("@")) defLine++;
    const base = indentOf(lines[defLine]);
    let end = defLine + 1;
    // skip multi-line signature
    for (let j = defLine + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      if (indentOf(l) <= base && !/^\s*[)\]}]/.test(l)) break;
      end = j + 1;
    }
    s.endLine = Math.max(end, s.line);
  }
  return syms;
}

function parseDocSections(rel: string, lines: string[], ext: string): SymbolInfo[] {
  const secs: SymbolInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (ext === ".md") {
      const m = /^(#{1,4})\s+(.+)$/.exec(lines[i]);
      if (m) secs.push({ name: m[2].trim(), qualname: m[2].trim(), kind: "section", path: rel, line: i + 1, endLine: i + 1 });
    } else if (i > 0 && /^([=\-~^"'`#*+])\1{2,}\s*$/.test(lines[i]) && lines[i - 1].trim() && !/^([=\-~^"'`#*+])\1{2,}/.test(lines[i - 1]) && lines[i].trim().length >= lines[i - 1].trim().length - 2) {
      secs.push({ name: lines[i - 1].trim(), qualname: lines[i - 1].trim(), kind: "section", path: rel, line: i, endLine: i });
    }
  }
  for (let k = 0; k < secs.length; k++) secs[k].endLine = k + 1 < secs.length ? secs[k + 1].line - 1 : lines.length;
  return secs;
}

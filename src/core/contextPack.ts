// Context assembly: decide what the model sees before it starts exploring.
//
// Strategy (stated in the write-up, visible in the panel's "Context ledger"):
//   1. Explicit mentions first: @path/to/file and @symbol are always included
//      (whole file up to a cap, or the symbol's body).
//   2. Automatic retrieval: BM25 over symbol-sized chunks, query = user request.
//      At most MAX_PER_FILE chunks per file so one big file cannot starve the rest.
//   3. Everything is packed greedily under a hard token budget; whatever does not
//      fit is listed as a pointer ("also relevant: path:lines") so the agent can
//      fetch it with read_file if it decides it needs it.
//   4. A ranked repo map (file -> top-level symbols) is included under its own
//      small budget so the agent knows what exists beyond the pack.
import { RepoIndex, estimateTokens, companionsOf } from "./repoIndex";

export interface LedgerEntry {
  path: string;
  startLine: number;
  endLine: number;
  tokens: number;
  reason: string;
  source: "mention" | "retrieval" | "pointer" | "agent";
  included: boolean;
  score?: number;
}

export interface ContextPack {
  text: string; // the block appended to the user message
  ledger: LedgerEntry[];
  budget: number;
  used: number;
  mapTokens: number;
}

const MAX_PER_FILE = 3;
const MENTION_FILE_CAP = 2500; // tokens

export function parseMentions(request: string): { files: string[]; symbols: string[] } {
  const files: string[] = [];
  const symbols: string[] = [];
  const re = /(?:^|\s)@([A-Za-z0-9_./\-]+[A-Za-z0-9_])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(request))) {
    const v = m[1];
    if (v.includes("/") || /\.[a-z]{1,5}$/i.test(v)) files.push(v);
    else symbols.push(v);
  }
  return { files, symbols };
}

export function buildContextPack(index: RepoIndex, request: string, budget: number): ContextPack {
  const ledger: LedgerEntry[] = [];
  const parts: string[] = [];
  let used = 0;
  const seen = new Set<string>(); // "path:start"
  const { files, symbols } = parseMentions(request);

  const addSnippet = (pathRel: string, start: number, end: number, reason: string, source: LedgerEntry["source"], score?: number): boolean => {
    const text = index.getText(pathRel);
    if (text === undefined) return false;
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    end = Math.min(end, lines.length);
    const body = lines.slice(start - 1, end).join("\n");
    const tokens = estimateTokens(body) + 12;
    const key = `${pathRel}:${start}`;
    if (seen.has(key)) return true;
    if (used + tokens > budget && source !== "mention") {
      ledger.push({ path: pathRel, startLine: start, endLine: end, tokens, reason: reason + " — over budget, given as pointer", source: "pointer", included: false, score });
      return false;
    }
    seen.add(key);
    used += tokens;
    ledger.push({ path: pathRel, startLine: start, endLine: end, tokens, reason, source, included: true, score });
    parts.push(`<snippet path="${pathRel}" lines="${start}-${end}" why="${reason.replace(/"/g, "'")}">\n${body}\n</snippet>`);
    return true;
  };

  // 1. explicit mentions
  for (const f of files) {
    const rel = f.replace(/^\.\//, "");
    const info = index.files.get(rel) ?? [...index.files.values()].find((x) => x.path.endsWith("/" + rel) || x.path === rel);
    if (!info) {
      ledger.push({ path: rel, startLine: 0, endLine: 0, tokens: 0, reason: "@mention not found in workspace", source: "mention", included: false });
      continue;
    }
    const capLines = Math.max(1, Math.floor((MENTION_FILE_CAP * 3.6) / Math.max(1, (info.tokens * 3.6) / info.lines)));
    addSnippet(info.path, 1, Math.min(info.lines, capLines), `@${f} mentioned by user`, "mention");
  }
  for (const s of symbols) {
    const hits = index.findSymbol(s, 3);
    if (!hits.length) {
      ledger.push({ path: `@${s}`, startLine: 0, endLine: 0, tokens: 0, reason: "@symbol not found in index", source: "mention", included: false });
      continue;
    }
    for (const h of hits) addSnippet(h.path, h.line, h.endLine, `@${s} → ${h.kind} ${h.qualname}`, "mention");
  }

  // 2. automatic retrieval
  const query = request.replace(/@[A-Za-z0-9_./\-]+/g, " ");
  const rankedAll = index.rank(query, 400);
  const top = rankedAll[0]?.score ?? 1;
  const ranked = rankedAll.filter((r) => r.score >= top * 0.25).slice(0, 60); // relevance floor

  // Companion expansion: the top-ranked source files pull in their test module
  // and docs page (a change to src/x.py usually needs tests/test_x.py, docs/x.rst).
  type Cand = { path: string; start: number; end: number; reason: string; score?: number };
  const cands: Cand[] = ranked.map((r) => ({ path: r.chunk.path, start: r.chunk.startLine, end: r.chunk.endLine, score: Number(r.score.toFixed(2)), reason: `matched ${[...new Set(r.matched)].slice(0, 6).join(", ")} in ${r.chunk.title}` }));
  const srcFiles = [...new Set(ranked.map((r) => r.chunk.path))].filter((p) => /\.(py|ts|js)$/.test(p) && !/(^|\/)(tests?|docs?|examples?)\//.test(p)).slice(0, 2);
  const companions: Cand[] = [];
  for (const src of srcFiles) {
    for (const c of companionsOf(index, src)) {
      const best = rankedAll.find((r) => r.chunk.path === c.path);
      const info = index.files.get(c.path)!;
      companions.push(best ? { path: c.path, start: best.chunk.startLine, end: best.chunk.endLine, reason: `companion: ${c.why}; best section ${best.chunk.title}`, score: Number(best.score.toFixed(2)) } : { path: c.path, start: 1, end: Math.min(info.lines, 60), reason: `companion: ${c.why}` });
    }
  }
  const ordered = [...cands.slice(0, 2), ...companions, ...cands.slice(2)];

  const perFile = new Map<string, number>();
  let pointers = 0;
  for (const c of ordered) {
    const n = perFile.get(c.path) ?? 0;
    if (n >= MAX_PER_FILE) continue;
    const ok = addSnippet(c.path, c.start, c.end, c.reason, "retrieval", c.score);
    perFile.set(c.path, n + 1);
    if (!ok && ++pointers >= 8) break;
  }

  // 3. repo map (own budget, ranked by the same query)
  const mapBudget = Math.min(1500, Math.max(400, Math.floor(budget * 0.25)));
  const map = index.repoMap(query, mapBudget);
  const mapTokens = estimateTokens(map);

  const pointerLines = ledger.filter((l) => l.source === "pointer").map((l) => `- ${l.path}:${l.startLine}-${l.endLine} (${l.reason.replace(" — over budget, given as pointer", "")})`);

  const text = [
    `<context budget_tokens="${budget}" used_tokens="${used}">`,
    `The editor pre-selected these snippets for your request using ${files.length + symbols.length ? "the user's @mentions plus " : ""}BM25 retrieval over the repository index. They are a starting point, not the whole picture: verify with read_file before editing.`,
    ...parts,
    pointerLines.length ? `<also_relevant note="did not fit the budget; read_file them if needed">\n${pointerLines.join("\n")}\n</also_relevant>` : "",
    `<repo_map ranked_by="relevance to request">\n${map}\n</repo_map>`,
    `</context>`,
  ]
    .filter(Boolean)
    .join("\n");

  return { text, ledger, budget, used, mapTokens };
}

// Line-level diff split into hunks that can be accepted or rejected one by one.
import { diffLines } from "diff";

export type Segment =
  | { kind: "same"; lines: string[] }
  | { kind: "hunk"; index: number; oldLines: string[]; newLines: string[]; oldStart: number; newStart: number };

export interface Hunk {
  index: number;
  oldStart: number; // 1-based line in the original
  oldLines: string[];
  newStart: number; // 1-based line in the proposal
  newLines: string[];
  contextBefore: string[];
  contextAfter: string[];
}

const splitLines = (s: string) => {
  if (s === "") return [];
  const arr = s.split("\n");
  if (arr[arr.length - 1] === "") arr.pop();
  return arr;
};

/** Both inputs must use "\n" line endings. */
export function computeSegments(oldText: string, newText: string): Segment[] {
  const changes = diffLines(oldText, newText);
  const segs: Segment[] = [];
  let oldLine = 1,
    newLine = 1,
    idx = 0;
  let pending: { oldLines: string[]; newLines: string[]; oldStart: number; newStart: number } | null = null;
  const flush = () => {
    if (pending && (pending.oldLines.length || pending.newLines.length)) segs.push({ kind: "hunk", index: idx++, ...pending });
    pending = null;
  };
  for (const c of changes) {
    const lines = splitLines(c.value);
    if (c.added || c.removed) {
      if (!pending) pending = { oldLines: [], newLines: [], oldStart: oldLine, newStart: newLine };
      if (c.removed) {
        pending.oldLines.push(...lines);
        oldLine += lines.length;
      } else {
        pending.newLines.push(...lines);
        newLine += lines.length;
      }
    } else {
      flush();
      segs.push({ kind: "same", lines });
      oldLine += lines.length;
      newLine += lines.length;
    }
  }
  flush();
  return segs;
}

export function hunksOf(segs: Segment[], context = 3): Hunk[] {
  const out: Hunk[] = [];
  segs.forEach((s, i) => {
    if (s.kind !== "hunk") return;
    const prev = segs[i - 1];
    const next = segs[i + 1];
    out.push({
      index: s.index,
      oldStart: s.oldStart,
      oldLines: s.oldLines,
      newStart: s.newStart,
      newLines: s.newLines,
      contextBefore: prev && prev.kind === "same" ? prev.lines.slice(-context) : [],
      contextAfter: next && next.kind === "same" ? next.lines.slice(0, context) : [],
    });
  });
  return out;
}

/** Rebuild text taking the new side of accepted hunks and the old side of the rest. */
export function applySelected(segs: Segment[], accepted: Set<number>, trailingNewline: boolean): string {
  const lines: string[] = [];
  for (const s of segs) {
    if (s.kind === "same") lines.push(...s.lines);
    else lines.push(...(accepted.has(s.index) ? s.newLines : s.oldLines));
  }
  return lines.join("\n") + (trailingNewline && lines.length ? "\n" : "");
}

export function hunkCount(segs: Segment[]) {
  return segs.filter((s) => s.kind === "hunk").length;
}

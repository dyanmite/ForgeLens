// The bridge between TrueForge's tool approval and the editor's per-hunk review.
//
//   model calls propose_edit ──► TrueForge pauses: tool.approval_required
//        │                           │
//        │                 extension: prepareProposal() → validate → show hunks
//        │                           │ user accepts/rejects each hunk
//        │                 ApprovalBook.record(callKey, accepted hunks, base hash)
//        │                           │ allow (≥1 hunk) / deny (0 hunks or guard failed)
//        ▼                           ▼
//   TrueForge calls the MCP tool ──► finalizeApprovedEdit(): look up the decision,
//   re-check the file did not change since review, apply ONLY accepted hunks.
//
// The MCP server refuses any write without a recorded decision, so even a
// misconfigured approval policy cannot cause a silent write.
import * as crypto from "crypto";
import { RepoIndex } from "./repoIndex";
import { applyEditOps, detectEol, EditOp, EditRejected, pythonSyntaxError, toLf, unresolvedImports } from "./edits";
import { applySelected, computeSegments, Hunk, hunksOf, Segment } from "./hunks";
import { callKey } from "./mcpServer";
import { resolveInWorkspace } from "./security";

export interface PreparedReview {
  key: string;
  tool: "propose_edit" | "propose_new_file";
  path: string;
  isNew: boolean;
  reason: string;
  before: string; // LF
  after: string; // LF
  eol: "\n" | "\r\n";
  segs: Segment[];
  hunks: Hunk[];
  warnings: string[];
  baseHash: string;
}

export interface RecordedDecision {
  accepted: Set<number>;
  total: number;
  baseHash: string;
  review: PreparedReview;
}

export const hashText = (s: string) => crypto.createHash("sha256").update(toLf(s)).digest("hex");

export class GuardFailure extends Error {}

export function prepareProposal(
  root: string,
  index: RepoIndex,
  readFile: (rel: string) => string | undefined,
  tool: string,
  args: Record<string, unknown>,
  pythonCmd: string
): PreparedReview {
  if (tool !== "propose_edit" && tool !== "propose_new_file") throw new Error(`not a write tool: ${tool}`);
  const { rel } = resolveInWorkspace(root, String(args.path ?? ""));
  const reason = String(args.reason ?? "");
  let before = "";
  let after: string;
  let eol: "\n" | "\r\n" = "\n";
  const isNew = tool === "propose_new_file";
  if (isNew) {
    if (readFile(rel) !== undefined) throw new GuardFailure(`${rel} already exists; use propose_edit`);
    after = toLf(String(args.content ?? ""));
    if (after && !after.endsWith("\n")) after += "\n";
  } else {
    const cur = readFile(rel);
    if (cur === undefined) throw new GuardFailure(`file not found: ${rel}. Find the right path with repo_map or search_code.`);
    eol = detectEol(cur);
    before = toLf(cur);
    try {
      after = applyEditOps(rel, before, args.edits as EditOp[]);
    } catch (e) {
      if (e instanceof EditRejected) throw new GuardFailure(e.message);
      throw e;
    }
  }
  const warnings: string[] = [];
  if (rel.endsWith(".py")) {
    const syn = pythonSyntaxError(after, pythonCmd);
    if (syn) throw new GuardFailure(`your change makes ${rel} invalid Python (${syn}). Fix the edit and propose it again.`);
    warnings.push(...unresolvedImports(index, rel, before, after));
  }
  const segs = computeSegments(before, after);
  return { key: callKey(tool, args), tool, path: rel, isNew, reason, before, after, eol, segs, hunks: hunksOf(segs), warnings, baseHash: hashText(before) };
}

export class ApprovalBook {
  private decisions = new Map<string, RecordedDecision>();

  record(review: PreparedReview, accepted: Set<number>) {
    this.decisions.set(review.key, { accepted, total: review.hunks.length, baseHash: review.baseHash, review });
  }

  take(tool: string, args: Record<string, unknown>): RecordedDecision | undefined {
    const k = callKey(tool, args);
    const d = this.decisions.get(k);
    if (d) this.decisions.delete(k);
    return d;
  }

  clear() {
    this.decisions.clear();
  }
}

/**
 * Called from the MCP tool handler after TrueForge approved the call.
 * Returns the new file text (with original EOLs) plus a message for the model.
 */
export function finalizeApprovedEdit(book: ApprovalBook, readFile: (rel: string) => string | undefined, tool: "propose_edit" | "propose_new_file", args: Record<string, unknown>): { rel: string; isNew: boolean; before: string | null; after: string; message: string } {
  const d = book.take(tool, args);
  if (!d) throw new Error("REFUSED: no review decision exists for this exact change. ForgeLens never writes without the user's per-hunk approval.");
  const r = d.review;
  const current = readFile(r.path);
  if (r.isNew ? current !== undefined : current === undefined || hashText(current) !== d.baseHash) {
    throw new Error(`REFUSED: ${r.path} changed after it was reviewed; re-read it and propose the edit again.`);
  }
  const accepted = [...d.accepted].sort((a, b) => a - b);
  const rejected = r.hunks.filter((h) => !d.accepted.has(h.index));
  let text = applySelected(r.segs, d.accepted, r.isNew ? true : r.before.endsWith("\n") || r.after.endsWith("\n"));
  if (r.eol === "\r\n") text = text.replace(/\n/g, "\r\n");
  const parts = [`Applied ${accepted.length} of ${d.total} hunk(s) to ${r.path}.`];
  if (rejected.length) {
    parts.push(`The user REJECTED ${rejected.length} hunk(s); those lines are unchanged. Do not propose them again:`);
    for (const h of rejected) parts.push(`  - hunk at line ${h.oldStart}: ${(h.newLines[0] ?? h.oldLines[0] ?? "").trim().slice(0, 100)}`);
  }
  return { rel: r.path, isNew: r.isNew, before: r.isNew ? null : current!, after: text, message: parts.join("\n") };
}

// Security guards shared by every editor tool the agent can call.
//
// 1. Workspace jail: every path the model sends is resolved against the workspace
//    root and rejected if it escapes it (../, absolute paths, symlinks out).
// 2. Deny list: VCS internals, virtualenvs, and secret-bearing files are never
//    readable or writable, even inside the workspace.
// 3. Redaction: high-confidence credential patterns are masked in anything we
//    send back to the model (file reads, search hits, command output).
import * as fs from "fs";
import * as path from "path";

export class SecurityError extends Error {}

const DENY_SEGMENTS = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache"]);
const DENY_FILE = [
  /^\.env(\..*)?$/i, // .env, .env.local ...
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.?(netrc|npmrc|pypirc)$/i,
  /^credentials(\.json)?$/i,
];

/** Normalise a model-supplied path to a workspace-relative POSIX path. Throws SecurityError. */
export function resolveInWorkspace(root: string, userPath: string): { abs: string; rel: string } {
  if (typeof userPath !== "string" || userPath.trim() === "") throw new SecurityError("path is required");
  if (userPath.includes("\0")) throw new SecurityError("invalid path");
  let p = userPath.trim().replace(/\\/g, "/");
  // Models often prefix paths with "./" or the workspace name; tolerate the former only.
  if (p.startsWith("./")) p = p.slice(2);
  if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p)) {
    // Allow absolute paths only if they already point inside the workspace.
    const rel = path.relative(root, p);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new SecurityError(`path outside workspace: ${userPath}`);
    p = rel.replace(/\\/g, "/");
  }
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel === "" ) return { abs, rel: "." };
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new SecurityError(`path outside workspace: ${userPath}`);
  // Follow symlinks for anything that already exists: the real target must also be inside.
  try {
    const real = fs.realpathSync.native(abs);
    const realRoot = fs.realpathSync.native(root);
    const realRel = path.relative(realRoot, real);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) throw new SecurityError(`path resolves outside workspace: ${userPath}`);
  } catch (e) {
    if (e instanceof SecurityError) throw e; // non-existent files are fine (new files)
  }
  const posix = rel.split(path.sep).join("/");
  assertAllowed(posix);
  return { abs, rel: posix };
}

export function isDenied(relPosix: string): boolean {
  const parts = relPosix.split("/");
  if (parts.some((s) => DENY_SEGMENTS.has(s))) return true;
  const base = parts[parts.length - 1];
  return DENY_FILE.some((re) => re.test(base));
}

export function assertAllowed(relPosix: string) {
  if (isDenied(relPosix)) throw new SecurityError(`access to ${relPosix} is blocked by ForgeLens policy (VCS internals, virtualenvs and secret files are off-limits)`);
}

// High-confidence secret shapes only. We deliberately do NOT mask generic
// `SECRET_KEY = ...` source lines: that would corrupt the text the model must
// quote back verbatim when it proposes an edit.
const SECRET_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_\-]{35}/g, // Google API key
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_\-]{20,}/g, // OpenAI / Anthropic style
  /\bgsk_[A-Za-z0-9]{20,}/g, // Groq
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g, // GitHub tokens
  /\bxox[baprs]-[A-Za-z0-9\-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, // JWT
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

export function containsSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => {
    re.lastIndex = 0;
    const hit = re.test(text);
    re.lastIndex = 0;
    return hit;
  });
}

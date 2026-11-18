// run_command: the only way the agent can execute anything.
//
// * Always requires user approval in TrueForge (require_approval_for_tools).
// * Allowlisted programs only, parsed into argv and spawned WITHOUT a shell, so
//   `;`, `&&`, pipes, redirects and substitutions are impossible.
// * Runs in the workspace root with a timeout and an output cap; output is
//   secret-redacted before it goes back to the model.
// * python / pytest / flask resolve to the workspace virtualenv when present.
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { redactSecrets } from "./security";

export interface CommandResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  argv: string[];
}

const ALLOW: Record<string, (args: string[]) => string | null> = {
  python: (a) => (a[0] === "-c" ? "inline python (-c) is not allowed; write a test instead" : null),
  pytest: () => null,
  flask: () => null,
  pip: (a) => (["show", "list", "freeze"].includes(a[0]) ? null : "only `pip show|list|freeze` are allowed"),
  git: (a) => (["status", "diff", "log", "show", "ls-files"].includes(a[0]) ? null : "only read-only git subcommands are allowed"),
};

export function splitArgs(cmd: string): string[] {
  if (/[;&|<>`]|\$\(/.test(cmd)) throw new Error("shell operators (; & | < > ` $()) are not allowed: run one command at a time");
  const out: string[] = [];
  let cur = "",
    q: string | null = null,
    has = false;
  for (const ch of cmd.trim()) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else cur += ch;
  }
  if (q) throw new Error("unterminated quote");
  if (cur || has) out.push(cur);
  return out;
}

export function venvBin(root: string, name: string): string | undefined {
  for (const dir of [".venv", "venv", "env"]) {
    for (const cand of [path.join(root, dir, "Scripts", name + ".exe"), path.join(root, dir, "bin", name)]) if (fs.existsSync(cand)) return cand;
  }
  return undefined;
}

export function pythonFor(root: string): string {
  return venvBin(root, "python") ?? (process.platform === "win32" ? "python" : "python3");
}

export function validateCommand(cmd: string): { argv: string[]; error?: string } {
  let argv: string[];
  try {
    argv = splitArgs(cmd);
  } catch (e) {
    return { argv: [], error: (e as Error).message };
  }
  if (!argv.length) return { argv, error: "empty command" };
  let prog = argv[0].toLowerCase().replace(/\.exe$/, "");
  if (prog === "python3" || prog === "py") prog = "python";
  // `python -m pytest ...` is the same as pytest
  if (prog === "python" && argv[1] === "-m" && ["pytest", "flask", "pip"].includes(argv[2])) {
    const sub = ALLOW[argv[2]](argv.slice(3));
    return sub ? { argv, error: sub } : { argv };
  }
  const rule = ALLOW[prog];
  if (!rule) return { argv, error: `'${argv[0]}' is not on the ForgeLens allowlist (${Object.keys(ALLOW).join(", ")})` };
  const err = rule(argv.slice(1));
  return err ? { argv, error: err } : { argv };
}

export function runCommand(root: string, cmd: string, opts: { timeoutMs?: number; maxChars?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
  const { argv, error } = validateCommand(cmd);
  if (error) return Promise.resolve({ exitCode: null, output: `REFUSED: ${error}`, timedOut: false, argv });
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxChars = opts.maxChars ?? 12_000;
  let prog = argv[0].toLowerCase().replace(/\.exe$/, "");
  if (prog === "python3" || prog === "py") prog = "python";
  const exe = prog === "git" ? "git" : venvBin(root, prog) ?? argv[0];
  return new Promise((resolve) => {
    let buf = "";
    let timedOut = false;
    const child = spawn(exe, argv.slice(1), {
      cwd: root,
      shell: false,
      windowsHide: true,
      env: { ...scrubEnv(process.env), PYTHONIOENCODING: "utf-8", NO_COLOR: "1", PY_COLORS: "0" },
    });
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      if (buf.length > maxChars * 4) buf = buf.slice(-maxChars * 2);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const abort = () => child.kill();
    opts.signal?.addEventListener("abort", abort, { once: true });
    const done = (code: number | null, extra = "") => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      let out = buf + extra;
      if (out.length > maxChars) out = `…(${out.length - maxChars} chars truncated)…\n` + out.slice(-maxChars);
      resolve({ exitCode: code, output: redactSecrets(out), timedOut, argv });
    };
    child.on("error", (e) => done(null, `\nfailed to start: ${e.message}`));
    child.on("close", (code) => done(code));
  });
}

/** Child processes get the user's environment minus anything that looks like a credential. */
function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k) && !/^(PATHEXT|SSH_AUTH_SOCK)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

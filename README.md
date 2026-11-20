# ForgeLens

**An editor-native coding agent for VS Code whose agent loop runs on [TrueForge](https://github.com/truefoundry/trueforge).**
Built for the TrueFoundry Forge-a-thon, Techfest IIT Bombay 2026.

ForgeLens finds the right code in repositories larger than a context window, makes multi-file changes you never had to spell out, shows every change hunk by hunk before it touches disk, and keeps working when the model behind it fails.

| | |
|---|---|
| **Demo video** | [Google Drive, 3:58](https://drive.google.com/drive/folders/10HFwfjKNWV2evrGeN6_MZfSyY4b_TSfI) |
| **Write-up** | [`docs/ForgeLens-writeup.pdf`](docs/ForgeLens-writeup.pdf) |
| **Starting point** | From scratch. No fork. Libraries only (see `package.json`). |
| **Agent loop** | TrueForge, local mode. The extension never calls a model provider. |
| **Agent definitions** | [`agents/forgelens-agent.json`](agents/forgelens-agent.json) (agent mode), [`agents/forgelens-inline.json`](agents/forgelens-inline.json) (inline edit) |
| **Example config** | [`config/settings.example.json`](config/settings.example.json) — no keys; keys live in TrueForge |
| **Licence** | MIT |

---

## What it does

| Capability | How ForgeLens does it |
|---|---|
| **Inline edit** | Select code → `Ctrl+Alt+K` → instruction. The rewrite streams from TrueForge and appears **in the editor** as a diff: removed lines red, new lines green, **Accept / Reject on every hunk** (CodeLens) plus Accept all `Ctrl+Shift+Enter` / Reject all `Ctrl+Shift+Backspace`. |
| **Agent mode** | Side panel. One request drives a TrueForge agent through the editor's MCP tools (repo map, search, symbols, read, propose edit, run command) until done. It finds the files itself. |
| **Context assembly** | `@file` / `@symbol` mentions + automatic BM25 retrieval over symbol-sized chunks, **under a token budget**, with test/doc companion expansion. A **Context ledger** shows every snippet chosen, its tokens and *why*; every file the agent reads is added with the agent's stated reason. |
| **Diff review** | Each `propose_edit` pauses TrueForge for approval and is rendered as per-hunk review cards + VS Code's native diff. Only accepted hunks are written. Applied changes are undoable (`Undo last`, `Revert run`, and plain `Ctrl+Z`). |
| **Streaming & cancel** | Tokens render as TrueForge streams them. `Esc` / **Stop** cancels the TrueForge session immediately. Edits are atomic per file, so a cancelled run never leaves a half-applied edit. |
| **Resilience** | Transient errors → retry with exponential backoff → **automatic fallback** to the next configured model, in the same TrueForge session (history kept). Auth/daily-quota errors skip retries. |

### Safety & security
- **No silent writes.** The MCP write tools refuse to write unless the user accepted hunks for *that exact call*; the file must also be unchanged since the review (stale-edit guard).
- **Guards before review:** the edit's `old_text` must exist exactly once (stops edits to code that does not exist), Python must still parse, and imports of non-existent names are flagged.
- **Workspace jail:** no `..` / absolute / symlink escapes; `.git`, virtualenvs, `.env*`, keys and credential files are never readable or writable.
- **Secret redaction** of API-key/token shapes in anything returned to the model.
- **Commands:** always need approval; allowlist (`pytest`, `python -m pytest`, `flask`, read-only `git`/`pip`), spawned **without a shell**, timeout, output cap, credential env vars stripped.
- **MCP endpoint:** `127.0.0.1` only, random bearer token per VS Code session, Host-header and browser-Origin checks. TrueForge is allowed to reach **only** `127.0.0.1` (see below).

---

## Setup (from a clean clone)

Requirements: **Node.js ≥ 22.14**, **VS Code ≥ 1.95**, **Python ≥ 3.10**, Git. Windows, macOS or Linux.

### 1. Start TrueForge in local mode
```bash
# macOS / Linux / Git Bash
./scripts/start-trueforge.sh
```
```powershell
# Windows PowerShell
./scripts/start-trueforge.ps1
```
This runs `npx @truefoundry/trueforge@latest` with `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'`.
TrueForge's SSRF guard blocks MCP servers on private addresses by default; ForgeLens' editor MCP server listens on `127.0.0.1`, so we allow exactly that host and nothing else.

Open http://localhost:8790 → **Settings → Models** and add at least one provider (API key goes **here**, never in this repo). We used:
- `google-gemini` (Google AI Studio key) → `gemini-3-5-flash`, `gemini-3-5-flash-lite`
- a custom OpenAI-compatible provider named `groq`, base URL `https://api.groq.com/openai/v1`, model ID `openai/gpt-oss-120b`, name `openai-gpt-oss-120b`

### 2. Build and run the extension
```bash
npm install
npm run build
npm test            # 11 unit tests: security, retrieval, hunks, guards, MCP auth
```
Open this folder in VS Code and press **F5** ("Run ForgeLens"). It opens a new window on `../flask-demo` (edit `.vscode/launch.json` for another repo). Or package it: `npm run package` → install the `.vsix`.

On activation ForgeLens indexes the workspace, starts its MCP server, **registers it in TrueForge as the `forgelens-editor` connector**, and syncs the two agent definitions from `agents/` into the TrueForge registry. The status bar shows `✓ ForgeLens · <model>`.

### 3. Choose models (no code changes)
Settings → `forgelens.models`: a list of TrueForge model names; first is primary, the rest are fallbacks. See [`config/settings.example.json`](config/settings.example.json). Any provider TrueForge supports works, including local models behind an OpenAI-compatible endpoint (Ollama, vLLM).

---

## Round 1 fixed tasks (pallets/flask 3.1.3)

```bash
git clone https://github.com/pallets/flask.git flask-demo
cd flask-demo && git checkout 3.1.3          # commit 22d92470
python -m venv .venv
.venv/Scripts/python -m pip install -e . "pytest==9.0.2" python-dotenv   # bin/python on macOS/Linux
echo ".venv/" >> .git/info/exclude           # keep git status clean
```

**A — Inline edit.** Open `src/flask/helpers.py`, select `get_debug_flag`, `Ctrl+Alt+K`, paste the instruction, review hunks, accept. Verify:
```bash
FLASK_DEBUG=off .venv/Scripts/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"   # False
```

**B — Agent mode.** ForgeLens panel (`Ctrl+Alt+L`), paste the instruction with no files named. Watch the Context ledger, review each hunk, allow the test run. Click **TrueForge session ↗** to show turns and tool calls. Verify:
```bash
.venv/Scripts/python -m pytest tests/test_cli.py -q
cd examples/tutorial && SECRET_KEY=x ../../.venv/Scripts/flask --app flaskr config
```

**C — Resilience.** `node scripts/setup-task-c.cjs` registers a provider pointing at a closed port. Set `forgelens.models` to [`config/task-c.settings.example.json`](config/task-c.settings.example.json), repeat Task A: ForgeLens retries with backoff, then falls back automatically; the editor stays responsive. Verify `git status` shows nothing changed until you accept.

---

## Architecture

```
┌──────────────── VS Code (ForgeLens extension) ────────────────┐
│ Agent panel (webview)   Inline edit (CodeLens hunks)          │
│        │ sessions / turns / SSE events / tool approvals       │
│        ▼              (@truefoundry/trueforge-sdk)            │
│  ForgeClient ── retry + backoff + model fallback ─────────────┼──► TrueForge (local, :8790)
│                                                               │        │ agent loop, sub-agents,
│  Editor MCP server (127.0.0.1, bearer) ◄──────────────────────┼────────┘ compaction, deferred tools
│   repo_map · search_code · find_symbol · read_file            │
│   list_files · propose_edit* · propose_new_file* · run_command*│  * require TrueForge approval
│        │                                                      │
│  RepoIndex (symbols, BM25 chunks)   ApprovalBook (per-hunk)   │
└───────────────────────────────────────────────────────────────┘
```

Source map: `src/core/` is editor-independent (tested in Node); `src/vscode/` is the VS Code layer; `media/` is the panel UI.

| File | Role |
|---|---|
| `src/core/forgeClient.ts` | TrueForge sessions, streaming, approvals, retry/fallback |
| `src/core/mcpServer.ts` | Editor tools as MCP (Streamable HTTP) |
| `src/core/repoIndex.ts`, `contextPack.ts` | Index, BM25 retrieval, budgeted context packs |
| `src/core/review.ts`, `edits.ts`, `hunks.ts` | Approval ↔ per-hunk review, guards, diffing |
| `src/core/security.ts`, `commands.ts` | Workspace jail, redaction, command policy |
| `src/vscode/agentPanel.ts`, `inlineEdit.ts` | Agent mode and inline edit UX |
| `scripts/dev-agent.cjs`, `dev-inline.cjs` | Headless rehearsal of Tasks B and A/C against real TrueForge |

## Models used

See the write-up for exact numbers. Development used Google Gemini (AI Studio API) and Groq (`openai/gpt-oss-120b`) through TrueForge. Nothing is hard-wired to a provider: switch with `forgelens.models`.

## Built with
TypeScript, esbuild, `@truefoundry/trueforge-sdk`, `@modelcontextprotocol/sdk`, `diff` (jsdiff), `zod`. AI coding assistant used during development: Claude Code (declared per the rules).

## Team
Vellore Institute of Technology (VIT), Vellore

| Name | GitHub |
|---|---|
| Jash Trehan | [@dyanmite](https://github.com/dyanmite) |
| Gaddam Kaarthik Reddy | [@Kaarthik2907](https://github.com/Kaarthik2907) |
| Navika Kapoor | [@nkapoor175](https://github.com/nkapoor175) |
| Parthvi Mishra | [@Parthvi1707](https://github.com/Parthvi1707) |

// ForgeLens agent panel (webview). Plain DOM, no framework, no remote resources.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ---- minimal, safe markdown (escape first, then format) -------------------
  function md(src) {
    const parts = String(src).split(/```/);
    let html = "";
    parts.forEach((p, i) => {
      if (i % 2 === 1) {
        const nl = p.indexOf("\n");
        const body = nl >= 0 ? p.slice(nl + 1) : p;
        html += `<pre class="code"><code>${esc(body.replace(/\n$/, ""))}</code></pre>`;
      } else {
        let t = esc(p);
        t = t.replace(/^### (.*)$/gm, "<h4>$1</h4>").replace(/^## (.*)$/gm, "<h3>$1</h3>").replace(/^# (.*)$/gm, "<h3>$1</h3>");
        t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/`([^`\n]+)`/g, "<code>$1</code>");
        t = t.replace(/^(\s*)[-*] (.*)$/gm, "$1• $2");
        html += t.replace(/\n/g, "<br>");
      }
    });
    return html;
  }

  // ---- layout ----------------------------------------------------------------
  const statusDot = el("span", { class: "dot idle" });
  const statusText = el("span", { class: "status-text" }, "Idle");
  const sessionBtn = el("button", { class: "link", title: "Open this run in the TrueForge UI", onclick: () => vscode.postMessage({ type: "openSession" }) }, "TrueForge session ↗");
  const header = el(
    "div",
    { class: "header" },
    el("div", { class: "status" }, statusDot, statusText),
    el(
      "div",
      { class: "actions" },
      sessionBtn,
      el("button", { class: "link", title: "Undo the last change ForgeLens applied", onclick: () => vscode.postMessage({ type: "undoLast" }) }, "Undo last"),
      el("button", { class: "link", title: "Revert every change from the last agent run", onclick: () => vscode.postMessage({ type: "revertRun" }) }, "Revert run"),
      el("button", { class: "link", title: "Start a new TrueForge session", onclick: () => vscode.postMessage({ type: "newChat" }) }, "New chat")
    )
  );
  const log = el("div", { class: "log" });
  const empty = el(
    "div",
    { class: "empty" },
    el("div", { class: "logo" }, "◈ ForgeLens"),
    el("p", {}, "Describe a change. The agent finds the files itself, and every edit comes back to you hunk by hunk before it touches disk."),
    el("p", { class: "hint" }, "Use @path/to/file or @symbol to pin context. Ctrl+Shift+K in an editor for inline edits.")
  );
  log.append(empty);

  const input = el("textarea", { class: "input", rows: 3, placeholder: "Ask ForgeLens to change something… (@ to mention, Enter to send)" });
  const sendBtn = el("button", { class: "primary", onclick: () => (running ? stop() : send()) }, "Send");
  const mentionBox = el("div", { class: "mentions hidden" });
  const composer = el("div", { class: "composer" }, mentionBox, input, el("div", { class: "row" }, el("span", { class: "hint" }, "Shift+Enter for newline · Esc to stop"), sendBtn));
  app.append(header, log, composer);

  let running = false;
  let stickBottom = true;
  log.addEventListener("scroll", () => (stickBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30));
  const scroll = () => {
    if (stickBottom) log.scrollTop = log.scrollHeight;
  };
  const add = (node) => {
    empty.remove();
    log.append(node);
    scroll();
    return node;
  };

  function setRunning(on) {
    running = on;
    sendBtn.textContent = on ? "Stop" : "Send";
    sendBtn.className = on ? "danger" : "primary";
  }
  function send() {
    const text = input.value.trim();
    if (!text) return;
    vscode.postMessage({ type: "send", text });
    input.value = "";
    hideMentions();
  }
  function stop() {
    vscode.postMessage({ type: "stop" });
  }

  // ---- @mentions -------------------------------------------------------------
  let mentionStart = -1;
  let mentionItems = [];
  let mentionSel = 0;
  function hideMentions() {
    mentionBox.classList.add("hidden");
    mentionStart = -1;
  }
  function renderMentions() {
    mentionBox.replaceChildren(
      ...mentionItems.map((it, i) =>
        el("div", { class: "mention" + (i === mentionSel ? " sel" : ""), onmousedown: (e) => (e.preventDefault(), pickMention(i)) }, el("span", { class: "tag" }, it.kind), " ", it.label, it.detail ? el("span", { class: "muted" }, "  " + it.detail) : null)
      )
    );
    mentionBox.classList.toggle("hidden", mentionItems.length === 0);
  }
  function pickMention(i) {
    const it = mentionItems[i];
    if (!it) return;
    const v = input.value;
    const caret = input.selectionStart;
    input.value = v.slice(0, mentionStart) + "@" + it.label + " " + v.slice(caret);
    const pos = mentionStart + it.label.length + 2;
    input.setSelectionRange(pos, pos);
    hideMentions();
    input.focus();
  }
  input.addEventListener("input", () => {
    const caret = input.selectionStart;
    const before = input.value.slice(0, caret);
    const m = /(^|\s)@([\w./\-]*)$/.exec(before);
    if (m) {
      mentionStart = caret - m[2].length - 1;
      vscode.postMessage({ type: "mentionQuery", q: m[2] });
    } else hideMentions();
  });
  input.addEventListener("keydown", (e) => {
    if (!mentionBox.classList.contains("hidden")) {
      if (e.key === "ArrowDown") return e.preventDefault(), (mentionSel = (mentionSel + 1) % mentionItems.length), renderMentions();
      if (e.key === "ArrowUp") return e.preventDefault(), (mentionSel = (mentionSel - 1 + mentionItems.length) % mentionItems.length), renderMentions();
      if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), pickMention(mentionSel);
      if (e.key === "Escape") return hideMentions();
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!running) send();
    }
    if (e.key === "Escape" && running) stop();
  });

  // ---- streamed messages -----------------------------------------------------
  const messages = new Map(); // id -> {node, text, reasoning}
  const threads = new Map(); // threadId -> container for sub-agent output
  let currentRun = null;
  let rafPending = new Set();

  function container(threadId) {
    if (!threadId || threadId === "main") return currentRun ?? log;
    return threads.get(threadId)?.body ?? currentRun ?? log;
  }
  function message(threadId, id) {
    let m = messages.get(id);
    if (!m) {
      const body = el("div", { class: "md" });
      const think = el("details", { class: "thinking hidden" }, el("summary", {}, "reasoning"), el("div", { class: "think-body" }));
      const node = el("div", { class: "msg assistant" + (threadId && threadId !== "main" ? " sub" : "") }, think, body);
      m = { node, body, think, text: "", reasoning: "" };
      messages.set(id, m);
      container(threadId).append(node);
      empty.remove();
    }
    return m;
  }
  function paint(id) {
    if (rafPending.has(id)) return;
    rafPending.add(id);
    requestAnimationFrame(() => {
      rafPending.delete(id);
      const m = messages.get(id);
      if (!m) return;
      m.body.innerHTML = md(m.text);
      if (m.reasoning) {
        m.think.classList.remove("hidden");
        m.think.querySelector(".think-body").textContent = m.reasoning;
      }
      scroll();
    });
  }

  const TOOL_ICON = { repo_map: "🗺", search_code: "🔎", find_symbol: "ƒ", read_file: "📄", list_files: "📁", propose_edit: "✎", propose_new_file: "＋", run_command: "▶" };
  const toolRows = new Map();
  function toolCall(m) {
    const a = m.args || {};
    const main = a.path || a.query || a.name || a.command || a.dir || "";
    const range = a.start_line ? `:${a.start_line}-${a.end_line ?? ""}` : "";
    const res = el("pre", { class: "tool-result hidden" });
    const row = el(
      "div",
      { class: "tool" },
      el(
        "div",
        { class: "tool-head", onclick: () => res.classList.toggle("hidden") },
        el("span", { class: "ico" }, TOOL_ICON[m.tool] || "⚙"),
        el("span", { class: "tname" }, m.tool),
        el("span", { class: "targ" }, String(main) + range),
        a.reason ? el("span", { class: "why" }, "— " + a.reason) : null
      ),
      res
    );
    toolRows.set(m.id, { row, res });
    container(m.threadId).append(row);
    scroll();
  }

  // ---- context ledger --------------------------------------------------------
  let ledgerList = null;
  let ledgerCount = null;
  function contextLedger(m) {
    const inc = m.ledger.filter((l) => l.included);
    const pct = Math.min(100, Math.round((m.used / m.budget) * 100));
    ledgerList = el("div", { class: "ledger-list" });
    ledgerCount = el("span", {}, `${inc.length} snippets`);
    for (const l of m.ledger) ledgerList.append(ledgerRow(l));
    const box = el(
      "details",
      { class: "ledger", open: true },
      el(
        "summary",
        {},
        el("b", {}, "Context ledger "),
        el("span", { class: "muted" }, " — what the agent was given, and why · "),
        ledgerCount,
        el("span", { class: "muted" }, ` · ${m.used}/${m.budget} tokens (+${m.mapTokens} repo map)`)
      ),
      el("div", { class: "budget" }, el("div", { class: "bar", style: `width:${pct}%` })),
      ledgerList
    );
    currentRun.append(box);
    scroll();
  }
  function ledgerRow(l) {
    const tag = { mention: "@mention", retrieval: "retrieved", pointer: "pointer", agent: "agent read" }[l.source] || l.source;
    return el(
      "div",
      { class: "lrow " + l.source + (l.included ? "" : " excluded") },
      el("span", { class: "tag " + l.source }, tag),
      el("a", { class: "lpath", onclick: () => vscode.postMessage({ type: "openFile", path: l.path, line: l.startLine }) }, `${l.path}${l.startLine ? `:${l.startLine}-${l.endLine}` : ""}`),
      l.tokens ? el("span", { class: "muted" }, ` ~${l.tokens}t`) : null,
      el("div", { class: "lwhy" }, l.reason)
    );
  }

  // ---- reviews ---------------------------------------------------------------
  const reviews = new Map();
  function reviewCard(m) {
    const state = new Map(m.hunks.map((h) => [h.index, true]));
    const counter = el("span", {});
    const updateCounter = () => {
      const n = [...state.values()].filter(Boolean).length;
      counter.textContent = `${n}/${m.hunks.length}`;
      vscode.postMessage({ type: "openDiff", reviewId: m.reviewId, accepted: [...state].filter(([, v]) => v).map(([k]) => k) });
    };
    const hunkNodes = m.hunks.map((h, i) => {
      const lines = [];
      let oldN = h.oldStart - h.before.length;
      let newN = h.newStart - h.before.length;
      for (const s of h.before) lines.push(el("div", { class: "dl ctx" }, el("span", { class: "ln" }, String(newN++)), " " + s)), oldN++;
      for (const s of h.removed) lines.push(el("div", { class: "dl del" }, el("span", { class: "ln" }, String(oldN++)), "-" + s));
      for (const s of h.added) lines.push(el("div", { class: "dl add" }, el("span", { class: "ln" }, String(newN++)), "+" + s));
      for (const s of h.after) lines.push(el("div", { class: "dl ctx" }, el("span", { class: "ln" }, String(newN++)), " " + s));
      const acc = el("button", { class: "mini on" }, "✓ Accept");
      const rej = el("button", { class: "mini" }, "✗ Reject");
      const box = el("div", { class: "hunk" }, el("div", { class: "hunk-head" }, el("span", {}, `Hunk ${i + 1} · line ${h.oldStart}`), el("span", { class: "spacer" }), acc, rej), el("div", { class: "diff" }, lines));
      const set = (v) => {
        state.set(h.index, v);
        acc.classList.toggle("on", v);
        rej.classList.toggle("on", !v);
        box.classList.toggle("rejected", !v);
        updateCounter();
      };
      acc.onclick = () => set(true);
      rej.onclick = () => set(false);
      return box;
    });
    const submit = el("button", { class: "primary" }, "Apply accepted hunks (", counter, ")");
    const rejectAll = el("button", {}, "Reject all");
    const card = el(
      "div",
      { class: "review" },
      el("div", { class: "review-head" }, el("span", { class: "ico" }, m.isNew ? "＋" : "✎"), el("b", {}, m.path), el("span", { class: "muted" }, m.isNew ? "  new file" : `  ${m.hunks.length} hunk(s)`)),
      m.reason ? el("div", { class: "why-block" }, m.reason) : null,
      ...(m.warnings || []).map((w) => el("div", { class: "warn" }, "⚠ symbol guard: " + w)),
      ...hunkNodes,
      el("div", { class: "review-actions" }, submit, rejectAll, el("button", { class: "link", onclick: () => vscode.postMessage({ type: "openDiff", reviewId: m.reviewId }) }, "Open diff"))
    );
    counter.textContent = `${m.hunks.length}/${m.hunks.length}`;
    submit.onclick = () => vscode.postMessage({ type: "reviewDecision", reviewId: m.reviewId, allow: true, accepted: [...state].filter(([, v]) => v).map(([k]) => k) });
    rejectAll.onclick = () => vscode.postMessage({ type: "reviewDecision", reviewId: m.reviewId, allow: false, accepted: [] });
    reviews.set(m.reviewId, card);
    currentRun.append(card);
    scroll();
  }
  function commandCard(m) {
    const card = el(
      "div",
      { class: "review cmd" },
      el("div", { class: "review-head" }, el("span", { class: "ico" }, "▶"), el("b", {}, "Run command?")),
      el("pre", { class: "code" }, m.command),
      m.reason ? el("div", { class: "why-block" }, m.reason) : null,
      el(
        "div",
        { class: "review-actions" },
        el("button", { class: "primary", onclick: () => vscode.postMessage({ type: "reviewDecision", reviewId: m.reviewId, allow: true }) }, "Allow"),
        el("button", { onclick: () => vscode.postMessage({ type: "reviewDecision", reviewId: m.reviewId, allow: false }) }, "Deny")
      )
    );
    reviews.set(m.reviewId, card);
    currentRun.append(card);
    scroll();
  }

  // ---- message handling ------------------------------------------------------
  window.addEventListener("message", (ev) => {
    const m = ev.data;
    switch (m.type) {
      case "reset":
        log.replaceChildren(empty);
        messages.clear();
        threads.clear();
        currentRun = null;
        break;
      case "user":
        currentRun = el("div", { class: "run" });
        add(el("div", { class: "msg user" }, m.text));
        add(currentRun);
        setRunning(true);
        break;
      case "context":
        contextLedger(m);
        break;
      case "ledgerAdd":
        if (ledgerList) {
          ledgerList.append(ledgerRow(m.entry));
          ledgerCount.textContent = `${ledgerList.children.length} entries`;
        }
        break;
      case "status": {
        const map = { starting: "Starting", running: "Running", paused: "Waiting for your review", retrying: "Retrying", fallback: "Falling back", done: "Done", error: "Error", cancelled: "Cancelled" };
        statusDot.className = "dot " + m.phase;
        statusText.textContent = `${map[m.phase] || m.phase} · ${m.model || ""}`;
        if (m.phase === "retrying" || m.phase === "fallback" || m.phase === "error") add(el("div", { class: "notice " + (m.phase === "error" ? "error" : "warn") }, (m.phase === "fallback" ? "⇄ Automatic model fallback: " : m.phase === "retrying" ? "↻ " : "✖ ") + (m.message || "")));
        break;
      }
      case "delta": {
        const msg = message(m.threadId, m.id);
        if (m.kind === "reasoning") msg.reasoning += m.chunk;
        else msg.text += m.chunk;
        paint(m.id);
        break;
      }
      case "toolCall":
        toolCall(m);
        break;
      case "toolResult": {
        const r = toolRows.get(m.id);
        if (r) {
          r.res.textContent = m.content;
          if (/^(ERROR|BLOCKED|REFUSED)/.test(m.content)) r.row.classList.add("failed");
        }
        break;
      }
      case "thread": {
        if (m.phase === "started") {
          const body = el("div", { class: "thread-body" });
          const box = el("details", { class: "thread", open: true }, el("summary", {}, "⑂ Sub-agent: ", el("b", {}, m.title || m.threadId), m.detail ? el("div", { class: "muted small" }, String(m.detail).slice(0, 300)) : null), body);
          threads.set(m.threadId, { box, body });
          (currentRun || log).append(box);
        } else {
          const t = threads.get(m.threadId);
          if (t) t.box.querySelector("summary").append(el("span", { class: "tag ok" }, " done"));
        }
        scroll();
        break;
      }
      case "compaction":
        add(el("div", { class: "notice info" }, m.phase === "started" ? "⟲ TrueForge is compacting the conversation to stay within the context window…" : "⟲ Compaction finished."));
        break;
      case "review":
        reviewCard(m);
        break;
      case "commandApproval":
        commandCard(m);
        break;
      case "autoRejected":
        (currentRun || log).append(el("div", { class: "notice error" }, `🛡 Guard rejected ${m.tool} ${m.path} before review: ${m.reason}`));
        scroll();
        break;
      case "reviewClosed": {
        const c = reviews.get(m.reviewId);
        if (c) {
          c.classList.add("closed");
          c.querySelectorAll("button").forEach((b) => (b.disabled = true));
          c.querySelector(".review-head").append(el("span", { class: "tag " + (m.result.startsWith("rej") || m.result === "denied" || m.result === "cancelled" ? "bad" : "ok") }, " " + m.result));
        }
        break;
      }
      case "done": {
        setRunning(false);
        const ok = m.status === "done";
        add(
          el(
            "div",
            { class: "notice " + (ok ? "ok" : m.status === "cancelled" ? "info" : "error") },
            ok ? `✔ Finished on ${m.model}${m.fellBack ? " (after automatic fallback)" : ""}. ` : m.status === "cancelled" ? "■ Cancelled. " : `✖ ${m.error || "failed"} `,
            m.changes && m.changes.length ? `${m.changes.length} change(s) applied: ${[...new Set(m.changes)].join(", ")}` : "No files changed."
          )
        );
        break;
      }
      case "notice":
        add(el("div", { class: "notice " + m.level }, m.text));
        break;
      case "mentionResults":
        mentionItems = m.items;
        mentionSel = 0;
        if (mentionStart >= 0) renderMentions();
        break;
      case "config":
        break;
      case "focusInput":
        input.focus();
        break;
    }
  });
})();

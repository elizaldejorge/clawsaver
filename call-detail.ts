/**
 * ClawSaver — Call Detail Store
 * Captures user messages + agent replies and serves full receipts.
 * God Mode only — each call row is clickable and opens a detail page.
 */

import type Database from "better-sqlite3";

// ── Extend the DB schema ──────────────────────────────────────────────────────

export function migrateCallDetails(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS call_details (
      call_id      INTEGER PRIMARY KEY,
      session_id   TEXT NOT NULL,
      user_message TEXT,
      agent_reply  TEXT,
      system_prompt_snippet TEXT,
      tools_used   TEXT,
      raw_cost     TEXT,
      stored_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pending_messages (
      session_id   TEXT PRIMARY KEY,
      user_message TEXT NOT NULL,
      stored_at    INTEGER NOT NULL
    );
  `);
}

// ── Store pending user message (before LLM call) ──────────────────────────────

export function storePendingMessage(
  db: Database.Database,
  sessionId: string,
  userMessage: string
) {
  db.prepare(`
    INSERT OR REPLACE INTO pending_messages (session_id, user_message, stored_at)
    VALUES (?, ?, ?)
  `).run(sessionId, userMessage.slice(0, 10000), Date.now());
}

export function popPendingMessage(
  db: Database.Database,
  sessionId: string
): string | null {
  const row = db.prepare(
    "SELECT user_message FROM pending_messages WHERE session_id = ?"
  ).get(sessionId) as { user_message: string } | undefined;

  if (row) {
    db.prepare("DELETE FROM pending_messages WHERE session_id = ?").run(sessionId);
    return row.user_message;
  }
  return null;
}

// ── Store full call detail ────────────────────────────────────────────────────

export interface CallDetail {
  callId: number;
  sessionId: string;
  userMessage: string | null;
  agentReply: string | null;
  systemPromptSnippet: string | null;
  toolsUsed: string | null;
  rawCost: string | null;
}

export function storeCallDetail(db: Database.Database, detail: CallDetail) {
  db.prepare(`
    INSERT OR REPLACE INTO call_details
      (call_id, session_id, user_message, agent_reply,
       system_prompt_snippet, tools_used, raw_cost, stored_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    detail.callId,
    detail.sessionId,
    detail.userMessage,
    detail.agentReply,
    detail.systemPromptSnippet,
    detail.toolsUsed,
    detail.rawCost,
    Date.now()
  );
}

export function getCallDetail(
  db: Database.Database,
  callId: number
): CallDetail | null {
  const row = db.prepare(`
    SELECT call_id, session_id, user_message, agent_reply,
           system_prompt_snippet, tools_used, raw_cost
    FROM call_details WHERE call_id = ?
  `).get(callId) as {
    call_id: number;
    session_id: string;
    user_message: string | null;
    agent_reply: string | null;
    system_prompt_snippet: string | null;
    tools_used: string | null;
    raw_cost: string | null;
  } | undefined;

  if (!row) return null;

  return {
    callId: row.call_id,
    sessionId: row.session_id,
    userMessage: row.user_message,
    agentReply: row.agent_reply,
    systemPromptSnippet: row.system_prompt_snippet,
    toolsUsed: row.tools_used,
    rawCost: row.raw_cost,
  };
}

// ── Detail page HTML ──────────────────────────────────────────────────────────

export function buildDetailHtml(
  db: Database.Database,
  callId: number
): string {
  // Get the call record
  const call = db.prepare(`
    SELECT ts, model, provider, input_tokens, output_tokens,
           cache_read_tokens, cost_usd, skill_name, channel, is_heartbeat
    FROM calls WHERE id = ?
  `).get(callId) as {
    ts: number;
    model: string;
    provider: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cost_usd: number;
    skill_name: string | null;
    channel: string | null;
    is_heartbeat: number;
  } | undefined;

  if (!call) {
    return `<html><body style="background:#08080e;color:#e2e2f0;font-family:monospace;padding:40px">
      <h2>Call #${callId} not found</h2>
      <a href="javascript:window.close()" style="color:#a78bfa">← Close</a>
    </body></html>`;
  }

  const detail = getCallDetail(db, callId);
  const time = new Date(call.ts).toISOString().replace("T", " ").slice(0, 19);
  const model = call.model.split("/").pop() ?? call.model;

  // Parse tools if any
  let toolsHtml = "";
  if (detail?.toolsUsed) {
    try {
      const tools = JSON.parse(detail.toolsUsed) as Array<{
        name: string;
        input: string;
        output: string;
      }>;
      toolsHtml = tools.map((t) => `
        <div class="tool-block">
          <div class="tool-name">🔧 ${esc(t.name)}</div>
          <div class="tool-section">
            <div class="section-label">Input</div>
            <pre class="code">${esc(t.input)}</pre>
          </div>
          <div class="tool-section">
            <div class="section-label">Output</div>
            <pre class="code">${esc(t.output)}</pre>
          </div>
        </div>`).join("");
    } catch {
      toolsHtml = `<pre class="code">${esc(detail.toolsUsed)}</pre>`;
    }
  }

  // Parse raw cost
  let costBreakdown = "";
  if (detail?.rawCost) {
    try {
      const cost = JSON.parse(detail.rawCost) as Record<string, number>;
      costBreakdown = Object.entries(cost)
        .map(([k, v]) => `<div class="cost-row"><span>${k}</span><span>$${v.toFixed(8)}</span></div>`)
        .join("");
    } catch {
      costBreakdown = "";
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Call #${callId} — ClawSaver ⚡</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600&family=Space+Mono:wght@400;700&display=swap');
:root {
  --bg:#08080e;--s1:#0f0f1a;--s2:#141424;--border:#1e1e3a;
  --text:#e2e2f0;--muted:#5a5a8a;--accent:#a78bfa;--accent2:#60a5fa;
  --gold:#fbbf24;--green:#34d399;--red:#f87171;--pink:#f472b6;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Space Grotesk',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:0}

body::before{
  content:'';position:fixed;inset:0;
  background-image:linear-gradient(rgba(167,139,250,0.02) 1px,transparent 1px),
    linear-gradient(90deg,rgba(167,139,250,0.02) 1px,transparent 1px);
  background-size:40px 40px;pointer-events:none;z-index:0;
}

header{
  position:sticky;top:0;z-index:10;
  padding:14px 28px;
  background:rgba(8,8,14,0.95);
  border-bottom:1px solid var(--border);
  display:flex;align-items:center;gap:12px;
  backdrop-filter:blur(10px);
}
.back{color:var(--accent);text-decoration:none;font-size:13px;display:flex;align-items:center;gap:6px}
.back:hover{color:#fff}
header h1{font-size:15px;font-weight:500}
.god-badge{background:linear-gradient(135deg,#a78bfa,#60a5fa);color:#fff;font-size:10px;font-weight:700;padding:2px 10px;border-radius:99px;letter-spacing:.1em}
.hdr-right{margin-left:auto;font-size:11px;color:var(--muted);font-family:'Space Mono',monospace}

.container{max-width:900px;margin:0 auto;padding:28px;position:relative;z-index:1}

/* Meta strip */
.meta-strip{
  display:grid;grid-template-columns:repeat(4,1fr);gap:10px;
  margin-bottom:24px;
}
.meta-card{
  background:var(--s1);border:1px solid var(--border);
  border-radius:10px;padding:14px 16px;
}
.meta-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px}
.meta-val{font-size:16px;font-weight:600;font-family:'Space Mono',monospace}
.meta-val.gold{color:var(--gold)}
.meta-val.purple{color:var(--accent)}
.meta-val.green{color:var(--green)}
.meta-val.blue{color:var(--accent2)}
.meta-sub{font-size:10px;color:var(--muted);margin-top:4px}

/* Sections */
.section{margin-bottom:20px}
.section-header{
  display:flex;align-items:center;gap:10px;
  margin-bottom:10px;
  font-size:11px;color:var(--muted);
  text-transform:uppercase;letter-spacing:.1em;
}
.section-header::after{content:'';flex:1;height:1px;background:var(--border)}
.section-badge{
  font-size:10px;font-weight:700;padding:2px 8px;
  border-radius:99px;text-transform:uppercase;letter-spacing:.08em;
}
.badge-user{background:rgba(96,165,250,0.15);color:var(--accent2)}
.badge-agent{background:rgba(167,139,250,0.15);color:var(--accent)}
.badge-system{background:rgba(90,90,138,0.3);color:var(--muted)}
.badge-tools{background:rgba(251,191,36,0.15);color:var(--gold)}
.badge-cost{background:rgba(52,211,153,0.15);color:var(--green)}

/* Message bubbles */
.bubble{
  background:var(--s1);border:1px solid var(--border);
  border-radius:12px;padding:16px 20px;
  font-size:13px;line-height:1.7;
  white-space:pre-wrap;word-break:break-word;
}
.bubble.user{border-color:rgba(96,165,250,0.3)}
.bubble.agent{border-color:rgba(167,139,250,0.3)}
.bubble.system{
  font-family:'Space Mono',monospace;
  font-size:11px;color:var(--muted);
  border-style:dashed;
}
.bubble.empty{color:var(--muted);font-style:italic;font-size:12px}

/* Token breakdown */
.token-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.token-card{
  background:var(--s2);border:1px solid var(--border);
  border-radius:8px;padding:10px 12px;text-align:center;
}
.token-n{font-size:20px;font-weight:700;font-family:'Space Mono',monospace}
.token-l{font-size:10px;color:var(--muted);margin-top:2px;text-transform:uppercase;letter-spacing:.06em}
.token-n.gold{color:var(--gold)}
.token-n.blue{color:var(--accent2)}
.token-n.green{color:var(--green)}
.token-n.muted{color:var(--muted)}

/* Cost breakdown */
.cost-row{
  display:flex;justify-content:space-between;
  padding:6px 0;border-bottom:1px solid var(--border);
  font-size:12px;font-family:'Space Mono',monospace;
}
.cost-row:last-child{border:none;font-weight:700;color:var(--green);font-size:13px}

/* Tool blocks */
.tool-block{
  background:var(--s1);border:1px solid rgba(251,191,36,0.2);
  border-radius:10px;padding:14px 16px;margin-bottom:10px;
}
.tool-name{font-size:13px;font-weight:600;color:var(--gold);margin-bottom:10px}
.tool-section{margin-bottom:8px}
.section-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
pre.code{
  background:var(--bg);border:1px solid var(--border);
  border-radius:6px;padding:10px 12px;
  font-family:'Space Mono',monospace;font-size:11px;
  white-space:pre-wrap;word-break:break-word;
  color:var(--text);max-height:200px;overflow-y:auto;
}

footer{
  text-align:center;padding:24px;
  font-size:10px;color:var(--muted);
  font-family:'Space Mono',monospace;
}
</style>
</head>
<body>

<header>
  <a class="back" href="http://localhost:3333">← Dashboard</a>
  <h1>Call #${callId}</h1>
  <span class="god-badge">⚡ GOD MODE</span>
  <div class="hdr-right">${time} UTC · ${esc(model)}</div>
</header>

<div class="container">

  <!-- Meta strip -->
  <div class="meta-strip">
    <div class="meta-card">
      <div class="meta-label">Total Cost</div>
      <div class="meta-val gold">$${call.cost_usd.toFixed(6)}</div>
      <div class="meta-sub">${call.provider}</div>
    </div>
    <div class="meta-card">
      <div class="meta-label">Input Tokens</div>
      <div class="meta-val blue">${call.input_tokens.toLocaleString()}</div>
      <div class="meta-sub">+ ${call.cache_read_tokens.toLocaleString()} cache read</div>
    </div>
    <div class="meta-card">
      <div class="meta-label">Output Tokens</div>
      <div class="meta-val purple">${call.output_tokens.toLocaleString()}</div>
      <div class="meta-sub">${call.skill_name ?? "direct"}</div>
    </div>
    <div class="meta-card">
      <div class="meta-label">Type</div>
      <div class="meta-val ${call.is_heartbeat ? "muted" : "green"}">${call.is_heartbeat ? "💓 Heartbeat" : "💬 Chat"}</div>
      <div class="meta-sub">${call.channel ?? "—"}</div>
    </div>
  </div>

  <!-- User message -->
  <div class="section">
    <div class="section-header">
      <span class="section-badge badge-user">👤 User</span>
    </div>
    <div class="bubble user ${!detail?.userMessage ? "empty" : ""}">
      ${detail?.userMessage ? esc(detail.userMessage) : "Message not captured (sent before ClawSaver v1.1 was installed)"}
    </div>
  </div>

  <!-- Agent reply -->
  <div class="section">
    <div class="section-header">
      <span class="section-badge badge-agent">🤖 Agent (${esc(model)})</span>
    </div>
    <div class="bubble agent ${!detail?.agentReply ? "empty" : ""}">
      ${detail?.agentReply ? esc(detail.agentReply) : "Reply not captured"}
    </div>
  </div>

  ${toolsHtml ? `
  <!-- Tools -->
  <div class="section">
    <div class="section-header">
      <span class="section-badge badge-tools">🔧 Tools Used</span>
    </div>
    ${toolsHtml}
  </div>` : ""}

  ${detail?.systemPromptSnippet ? `
  <!-- System prompt snippet -->
  <div class="section">
    <div class="section-header">
      <span class="section-badge badge-system">⚙️ System Context (first 500 chars)</span>
    </div>
    <div class="bubble system">${esc(detail.systemPromptSnippet)}</div>
  </div>` : ""}

  <!-- Token breakdown -->
  <div class="section">
    <div class="section-header">
      <span class="section-badge badge-cost">📊 Token Breakdown</span>
    </div>
    <div class="token-grid">
      <div class="token-card">
        <div class="token-n blue">${call.input_tokens.toLocaleString()}</div>
        <div class="token-l">Input</div>
      </div>
      <div class="token-card">
        <div class="token-n purple">${call.output_tokens.toLocaleString()}</div>
        <div class="token-l">Output</div>
      </div>
      <div class="token-card">
        <div class="token-n green">${call.cache_read_tokens.toLocaleString()}</div>
        <div class="token-l">Cache Read</div>
      </div>
    </div>
  </div>

  ${costBreakdown ? `
  <!-- Cost breakdown -->
  <div class="section">
    <div class="section-header">
      <span class="section-badge badge-cost">💰 Cost Breakdown</span>
    </div>
    <div class="bubble" style="padding:0 16px">
      ${costBreakdown}
    </div>
  </div>` : ""}

</div>

<footer>
  ClawSaver ⚡ God Mode · Call #${callId} · ${time} UTC · All data local
</footer>
</body>
</html>`;
}

function esc(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

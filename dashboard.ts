/**
 * ClawSaver — Local dashboard server
 * Serves a read-only HTML page at http://localhost:3333
 * Binds to 127.0.0.1 only — never exposed to the network.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import type Database from "better-sqlite3";
import {
  getSpend,
  getTopSkills,
  getRecentCalls,
} from "./db.js";
import { formatUSD, pricingAge } from "./pricing.js";

const PORT = 3333;
const DAY = 86_400_000;

function buildHtml(db: Database.Database): string {
  const now = Date.now();
  const day24 = getSpend(db, now - DAY);
  const day7  = getSpend(db, now - 7 * DAY);
  const day30 = getSpend(db, now - 30 * DAY);
  const skills = getTopSkills(db, now - 30 * DAY);
  const calls  = getRecentCalls(db, 150);

  // ── skill bar rows ────────────────────────────────────────────────────────
  const maxCost = skills[0]?.cost_usd ?? 1;
  const skillRows = skills.map((s) => {
    const pct = Math.round((s.cost_usd / maxCost) * 100);
    return `
      <div class="sr">
        <span class="sr-name">${esc(s.skill)}</span>
        <div class="sr-bar-wrap"><div class="sr-bar" style="width:${pct}%"></div></div>
        <span class="sr-cost">${formatUSD(s.cost_usd)}</span>
        <span class="sr-calls">${s.call_count} calls</span>
      </div>`;
  }).join("") || "<p class='empty'>No calls recorded yet.</p>";

  // ── call table rows ───────────────────────────────────────────────────────
  const callRows = calls.map((c) => {
    const t = new Date(c.ts).toISOString().replace("T", " ").slice(0, 19);
    const model = c.model.split("/").pop() ?? c.model;
    const hb = c.is_heartbeat ? "💓" : "💬";
    const cls = c.is_heartbeat ? ' class="hb"' : "";
    const tip = c.task_snippet ? ` title="${esc(c.task_snippet)}"` : "";
    return `
      <tr${cls}${tip}>
        <td>${t}</td>
        <td>${esc(model)}</td>
        <td class="num">${c.input_tokens.toLocaleString()}</td>
        <td class="num">${c.output_tokens.toLocaleString()}</td>
        <td class="cost">${formatUSD(c.cost_usd)}</td>
        <td>${esc(c.skill)}</td>
        <td>${esc(c.channel)}</td>
        <td class="center">${hb}</td>
      </tr>`;
  }).join("") || `<tr><td colspan="8" class="empty">No calls yet.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClawSaver — Where did my money go?</title>
<style>
  :root{--bg:#0d0d10;--surface:#18181c;--border:#27272d;--text:#e2e2e6;--muted:#6b6b72;--accent:#7c5af0;--green:#4ade80;--amber:#fbbf24;--red:#f87171;--mono:'SF Mono','Fira Code',monospace}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--mono);background:var(--bg);color:var(--text);min-height:100vh;font-size:13px}
  header{padding:20px 28px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:14px}
  header h1{font-size:17px;letter-spacing:-.4px}
  .pill{background:var(--accent);color:#fff;font-size:10px;padding:2px 9px;border-radius:99px;font-weight:600}
  .pill.local{background:#2a5c3a}
  .muted{color:var(--muted);font-size:11px}
  .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding:22px 28px}
  .sc{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px}
  .sc-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:8px}
  .sc-val{font-size:26px;font-weight:700;color:var(--amber)}
  .sc-sub{font-size:10px;color:var(--muted);margin-top:4px}
  .section{padding:0 28px 28px}
  .section h2{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:12px;padding-top:4px}
  .sr{display:flex;align-items:center;gap:10px;margin-bottom:7px}
  .sr-name{min-width:140px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sr-bar-wrap{flex:1;background:var(--border);border-radius:3px;height:5px;overflow:hidden}
  .sr-bar{height:100%;background:var(--accent);border-radius:3px}
  .sr-cost{min-width:72px;text-align:right;color:var(--amber);font-size:12px}
  .sr-calls{min-width:58px;text-align:right;color:var(--muted);font-size:11px}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;padding:7px 10px;border-bottom:1px solid var(--border);color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:500}
  td{padding:7px 10px;border-bottom:1px solid var(--border);vertical-align:middle}
  tr:hover td{background:var(--surface)}
  tr.hb td{color:var(--muted)}
  .cost{color:var(--amber);font-weight:600}
  .num{text-align:right}
  .center{text-align:center}
  .empty{color:var(--muted);padding:20px;text-align:center}
  footer{padding:12px 28px;color:var(--muted);font-size:10px;border-top:1px solid var(--border)}
</style>
</head>
<body>
<header>
  <span>🦞</span>
  <h1>ClawSaver</h1>
  <span class="muted">Where did my money go?</span>
  <span class="pill local">LOCAL ONLY — no data leaves your machine</span>
  <span class="muted" style="margin-left:auto">Pricing: ${pricingAge()}</span>
</header>

<div class="stats">
  <div class="sc">
    <div class="sc-label">Last 24 hours</div>
    <div class="sc-val">${formatUSD(day24.total_usd)}</div>
    <div class="sc-sub">${day24.call_count} calls · ${(day24.total_tokens/1000).toFixed(0)}k tokens</div>
  </div>
  <div class="sc">
    <div class="sc-label">Last 7 days</div>
    <div class="sc-val">${formatUSD(day7.total_usd)}</div>
    <div class="sc-sub">${day7.call_count} calls · ${(day7.total_tokens/1000).toFixed(0)}k tokens</div>
  </div>
  <div class="sc">
    <div class="sc-label">Last 30 days</div>
    <div class="sc-val">${formatUSD(day30.total_usd)}</div>
    <div class="sc-sub">${day30.call_count} calls · ${(day30.total_tokens/1000).toFixed(0)}k tokens</div>
  </div>
</div>

<div class="section">
  <h2>Cost by skill — last 30 days</h2>
  ${skillRows}
</div>

<div class="section">
  <h2>Call timeline — last 150 calls (hover for task preview)</h2>
  <table>
    <thead>
      <tr>
        <th>Time (UTC)</th><th>Model</th><th>In tokens</th><th>Out tokens</th>
        <th>Cost</th><th>Skill</th><th>Channel</th><th>Type</th>
      </tr>
    </thead>
    <tbody>${callRows}</tbody>
  </table>
</div>

<footer>ClawSaver v1.0 · Data at ~/.openclaw/clawsaver/costs.db · Refresh page to update</footer>
</body>
</html>`;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function startDashboard(db: Database.Database): void {
  const server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        const html = buildHtml(db);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      } catch (err) {
        res.writeHead(500);
        res.end("ClawSaver dashboard error — check gateway logs.");
        console.error("[ClawSaver] dashboard error:", err);
      }
    }
  );

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.warn(`[ClawSaver] Port ${PORT} in use — dashboard not started.`);
    } else {
      console.error("[ClawSaver] dashboard server error:", err);
    }
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[ClawSaver] Dashboard → http://localhost:${PORT}`);
  });
}

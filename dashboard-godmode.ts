/**
 * ClawSaver — God Mode Dashboard
 * Completely different look. Animated. More data. More power.
 * Only renders when God Mode is active.
 */

import type Database from "better-sqlite3";
import { getSpend, getTopSkills, getRecentCalls } from "./db.js";
import { formatUSD } from "./pricing.js";
import { getGodState } from "./godmode.js";
import { getSessionLimit, formatLimitStatus } from "./spend-limit.js";

const DAY = 86_400_000;

export function buildGodHtml(db: Database.Database): string {
  const now = Date.now();
  const { owner } = getGodState();

  const d1  = getSpend(db, now - DAY);
  const d7  = getSpend(db, now - 7 * DAY);
  const d30 = getSpend(db, now - 30 * DAY);
  const d90 = getSpend(db, now - 90 * DAY);

  const skills  = getTopSkills(db, now - 30 * DAY, 12);
  const calls   = getRecentCalls(db, 300);

  // Hourly breakdown for last 24h (for the activity chart)
  const hourlyData: number[] = Array(24).fill(0);
  for (const c of calls) {
    const hoursAgo = Math.floor((now - c.ts) / 3_600_000);
    if (hoursAgo < 24) hourlyData[23 - hoursAgo] += c.cost_usd;
  }
  const maxHourly = Math.max(...hourlyData, 0.0001);
  const hourlyBars = hourlyData
    .map((v, i) => {
      const h = Math.round((v / maxHourly) * 60);
      const label = `${(now - (23 - i) * 3_600_000) | 0}`.slice(-2);
      return `<div class="hbar" style="height:${h}px" title="${formatUSD(v)}"></div>`;
    })
    .join("");

  // Model breakdown
  const modelBreakdown = db.prepare(`
    SELECT model, SUM(cost_usd) as cost, COUNT(*) as calls,
           SUM(input_tokens) as inp, SUM(output_tokens) as out
    FROM calls WHERE ts >= ?
    GROUP BY model ORDER BY cost DESC LIMIT 8
  `).all(now - 30 * DAY) as Array<{
    model: string; cost: number; calls: number; inp: number; out: number;
  }>;

  const maxModel = modelBreakdown[0]?.cost ?? 0.0001;

  // Cost by hour of day (when is the agent most expensive?)
  const byHour = db.prepare(`
    SELECT strftime('%H', datetime(ts/1000, 'unixepoch')) as hr,
           SUM(cost_usd) as cost
    FROM calls WHERE ts >= ?
    GROUP BY hr ORDER BY hr
  `).all(now - 30 * DAY) as Array<{ hr: string; cost: number }>;

  const hourMap: Record<string, number> = {};
  for (const r of byHour) hourMap[r.hr] = r.cost;
  const peakHour = Object.entries(hourMap).sort((a, b) => b[1] - a[1])[0];

  const callRows = calls.slice(0, 200).map((c) => {
    const t = new Date(c.ts).toISOString().replace("T", " ").slice(0, 19);
    const model = c.model.split("/").pop() ?? c.model;
    const hb = c.is_heartbeat ? "💓" : "💬";
    const costClass = c.cost_usd > 0.01 ? "cost-high" : c.cost_usd > 0.001 ? "cost-mid" : "cost-low";
    return `
      <tr class="${c.is_heartbeat ? "hb" : ""}" title="${esc(c.task_snippet ?? "")}">
        <td>${t}</td>
        <td class="model">${esc(model)}</td>
        <td class="num">${c.input_tokens.toLocaleString()}</td>
        <td class="num">${c.output_tokens.toLocaleString()}</td>
        <td class="${costClass}">${formatUSD(c.cost_usd)}</td>
        <td>${esc(c.skill)}</td>
        <td>${esc(c.channel)}</td>
        <td class="center">${hb}</td>
      </tr>`;
  }).join("");

  const skillRows = skills.map((s, i) => {
    const pct = (s.cost_usd / (skills[0]?.cost_usd ?? 1)) * 100;
    const colors = ["#a78bfa","#818cf8","#60a5fa","#34d399","#fbbf24","#f87171","#e879f9","#fb923c"];
    const color = colors[i % colors.length];
    return `
      <div class="sr">
        <span class="sr-rank">${i + 1}</span>
        <span class="sr-name">${esc(s.skill)}</span>
        <div class="sr-bar-wrap"><div class="sr-bar" style="width:${pct}%;background:${color}"></div></div>
        <span class="sr-cost">${formatUSD(s.cost_usd)}</span>
        <span class="sr-calls">${s.call_count}</span>
      </div>`;
  }).join("");

  const modelRows = modelBreakdown.map((m) => {
    const pct = (m.cost / maxModel) * 100;
    const short = m.model.split("/").pop() ?? m.model;
    return `
      <div class="mr">
        <span class="mr-name">${esc(short)}</span>
        <div class="mr-bar-wrap"><div class="mr-bar" style="width:${pct}%"></div></div>
        <span class="mr-cost">${formatUSD(m.cost)}</span>
        <span class="mr-meta">${m.calls} calls · ${((m.inp + m.out)/1000).toFixed(0)}k tok</span>
      </div>`;
  }).join("");

  const sessionLimit = getSessionLimit(db);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClawSaver ⚡ GOD MODE</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=Space+Mono:wght@400;700&display=swap');

:root {
  --bg: #08080e;
  --s1: #0f0f1a;
  --s2: #141424;
  --border: #1e1e3a;
  --text: #e2e2f0;
  --muted: #5a5a8a;
  --accent: #a78bfa;
  --accent2: #60a5fa;
  --gold: #fbbf24;
  --green: #34d399;
  --red: #f87171;
  --pink: #f472b6;
  --glow: 0 0 20px rgba(167,139,250,0.3);
  --glow2: 0 0 40px rgba(167,139,250,0.15);
}

* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: 'Space Grotesk', sans-serif;
  background: var(--bg);
  color: var(--text);
  min-height: 100vh;
  overflow-x: hidden;
}

/* Animated background grid */
body::before {
  content: '';
  position: fixed;
  inset: 0;
  background-image:
    linear-gradient(rgba(167,139,250,0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(167,139,250,0.03) 1px, transparent 1px);
  background-size: 40px 40px;
  pointer-events: none;
  z-index: 0;
}

/* Glowing orbs */
body::after {
  content: '';
  position: fixed;
  width: 600px; height: 600px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(167,139,250,0.06) 0%, transparent 70%);
  top: -200px; left: -200px;
  pointer-events: none;
  z-index: 0;
  animation: orb 8s ease-in-out infinite alternate;
}

@keyframes orb {
  to { transform: translate(200px, 100px); }
}

header {
  position: relative;
  z-index: 1;
  padding: 20px 32px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 16px;
  background: linear-gradient(135deg, rgba(167,139,250,0.05), transparent);
}

.logo { font-size: 22px; font-weight: 700; letter-spacing: -1px; }
.logo span { color: var(--accent); }

.god-badge {
  background: linear-gradient(135deg, #a78bfa, #60a5fa);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  padding: 3px 12px;
  border-radius: 99px;
  letter-spacing: .1em;
  text-transform: uppercase;
  box-shadow: var(--glow);
  animation: pulse-badge 2s ease-in-out infinite;
}

@keyframes pulse-badge {
  0%, 100% { box-shadow: 0 0 10px rgba(167,139,250,0.4); }
  50% { box-shadow: 0 0 25px rgba(167,139,250,0.8); }
}

.owner { font-size: 12px; color: var(--muted); }
.owner strong { color: var(--accent); }
.hdr-right { margin-left: auto; font-size: 11px; color: var(--muted); font-family: 'Space Mono', monospace; }

/* Stats grid */
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  padding: 24px 32px 0;
  position: relative; z-index: 1;
}

.sc {
  background: var(--s1);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px 20px;
  position: relative;
  overflow: hidden;
  transition: border-color .2s, box-shadow .2s;
}

.sc:hover {
  border-color: var(--accent);
  box-shadow: var(--glow2);
}

.sc::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  opacity: 0.5;
}

.sc-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .1em; margin-bottom: 10px; }
.sc-val { font-size: 28px; font-weight: 700; font-family: 'Space Mono', monospace; }
.sc-val.amber { color: var(--gold); }
.sc-val.green { color: var(--green); }
.sc-val.purple { color: var(--accent); }
.sc-val.blue { color: var(--accent2); }
.sc-sub { font-size: 11px; color: var(--muted); margin-top: 6px; }

/* Activity chart */
.chart-section {
  padding: 24px 32px 0;
  position: relative; z-index: 1;
}

.section-title {
  font-size: 11px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: .1em;
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
}

.section-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border);
}

.hourly-chart {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 70px;
  background: var(--s1);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 12px 4px;
}

.hbar {
  flex: 1;
  background: linear-gradient(to top, var(--accent), var(--accent2));
  border-radius: 2px 2px 0 0;
  min-height: 2px;
  opacity: 0.7;
  transition: opacity .2s;
}

.hbar:hover { opacity: 1; }

/* Two-column layout */
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  padding: 16px 32px 0;
  position: relative; z-index: 1;
}

.panel {
  background: var(--s1);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 18px;
}

/* Skill rows */
.sr { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.sr-rank { font-size: 11px; color: var(--muted); width: 16px; text-align: right; font-family: 'Space Mono', monospace; }
.sr-name { font-size: 12px; min-width: 100px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sr-bar-wrap { flex: 1; background: var(--s2); border-radius: 3px; height: 4px; }
.sr-bar { height: 4px; border-radius: 3px; }
.sr-cost { font-size: 11px; min-width: 56px; text-align: right; color: var(--gold); font-family: 'Space Mono', monospace; }
.sr-calls { font-size: 10px; color: var(--muted); min-width: 40px; text-align: right; }

/* Model rows */
.mr { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.mr-name { font-size: 12px; min-width: 120px; font-family: 'Space Mono', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mr-bar-wrap { flex: 1; background: var(--s2); border-radius: 3px; height: 4px; }
.mr-bar { height: 4px; border-radius: 3px; background: linear-gradient(90deg, var(--accent2), var(--accent)); }
.mr-cost { font-size: 11px; min-width: 56px; text-align: right; color: var(--accent2); font-family: 'Space Mono', monospace; }
.mr-meta { font-size: 10px; color: var(--muted); min-width: 90px; text-align: right; }

/* Limit panel */
.limit-panel {
  margin: 16px 32px 0;
  background: ${sessionLimit > 0 ? "linear-gradient(135deg, rgba(251,191,36,0.05), rgba(167,139,250,0.05))" : "var(--s1)"};
  border: 1px solid ${sessionLimit > 0 ? "rgba(251,191,36,0.3)" : "var(--border)"};
  border-radius: 12px;
  padding: 14px 18px;
  display: flex;
  align-items: center;
  gap: 16px;
  position: relative; z-index: 1;
}

.limit-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }
.limit-val { font-size: 18px; font-weight: 700; color: var(--gold); font-family: 'Space Mono', monospace; }
.limit-cmd { font-size: 11px; color: var(--muted); margin-left: auto; font-family: 'Space Mono', monospace; }

/* Call table */
.table-section {
  padding: 16px 32px 32px;
  position: relative; z-index: 1;
}

table { width: 100%; border-collapse: collapse; font-size: 11px; font-family: 'Space Mono', monospace; }
th { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: .1em; font-weight: 500; }
td { padding: 6px 10px; border-bottom: 1px solid rgba(30,30,58,0.5); }
tr:hover td { background: var(--s1); }
tr.hb td { color: var(--muted); opacity: 0.6; }
.cost-high { color: var(--red); font-weight: 700; }
.cost-mid { color: var(--gold); }
.cost-low { color: var(--green); }
.num { text-align: right; }
.center { text-align: center; }
.model { color: var(--accent); }

footer {
  padding: 16px 32px;
  border-top: 1px solid var(--border);
  font-size: 10px;
  color: var(--muted);
  font-family: 'Space Mono', monospace;
  position: relative; z-index: 1;
  display: flex;
  gap: 24px;
}

.footer-stat strong { color: var(--accent); }

/* Scan line animation */
@keyframes scan {
  0% { transform: translateY(-100%); }
  100% { transform: translateY(100vh); }
}

.scan-line {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, rgba(167,139,250,0.4), transparent);
  animation: scan 4s linear infinite;
  pointer-events: none;
  z-index: 999;
}
</style>
</head>
<body>
<div class="scan-line"></div>

<header>
  <div class="logo">🦞 Claw<span>Saver</span></div>
  <div class="god-badge">⚡ GOD MODE</div>
  <div class="owner">Welcome back, <strong>${esc(owner)}</strong></div>
  <div class="hdr-right">
    ALL DATA LOCAL · REFRESH TO UPDATE<br>
    ${new Date().toISOString().slice(0, 19)} UTC
  </div>
</header>

<div class="stats">
  <div class="sc">
    <div class="sc-label">Last 24 hours</div>
    <div class="sc-val amber">${formatUSD(d1.total_usd)}</div>
    <div class="sc-sub">${d1.call_count} calls · ${(d1.total_tokens/1000).toFixed(1)}k tokens</div>
  </div>
  <div class="sc">
    <div class="sc-label">Last 7 days</div>
    <div class="sc-val purple">${formatUSD(d7.total_usd)}</div>
    <div class="sc-sub">${d7.call_count} calls · ${(d7.total_tokens/1000).toFixed(1)}k tokens</div>
  </div>
  <div class="sc">
    <div class="sc-label">Last 30 days</div>
    <div class="sc-val blue">${formatUSD(d30.total_usd)}</div>
    <div class="sc-sub">${d30.call_count} calls · ${(d30.total_tokens/1000).toFixed(1)}k tokens</div>
  </div>
  <div class="sc">
    <div class="sc-label">Last 90 days</div>
    <div class="sc-val green">${formatUSD(d90.total_usd)}</div>
    <div class="sc-sub">${d90.call_count} calls · ${(d90.total_tokens/1000).toFixed(1)}k tokens</div>
  </div>
</div>

<div class="chart-section">
  <div class="section-title">Hourly activity — last 24h</div>
  <div class="hourly-chart">${hourlyBars}</div>
</div>

${sessionLimit > 0 ? `
<div class="limit-panel">
  <div>
    <div class="limit-label">Session Limit Active</div>
    <div class="limit-val">${formatUSD(sessionLimit)}</div>
  </div>
  <div style="font-size:12px;color:var(--text)">${formatLimitStatus(db).split('\n').slice(0,2).join(' · ')}</div>
  <div class="limit-cmd">/clawsaver-continue · /clawsaver-stop · /clawsaver-limit 0</div>
</div>` : `
<div class="limit-panel">
  <div>
    <div class="limit-label">Session Limit</div>
    <div style="font-size:13px;color:var(--muted)">Not set</div>
  </div>
  <div class="limit-cmd">Set one: /clawsaver-limit 5</div>
</div>`}

<div class="two-col">
  <div class="panel">
    <div class="section-title" style="margin-bottom:12px">Cost by skill — 30d</div>
    ${skillRows || "<p style='color:var(--muted);font-size:12px'>No data yet.</p>"}
  </div>
  <div class="panel">
    <div class="section-title" style="margin-bottom:12px">Cost by model — 30d</div>
    ${modelRows || "<p style='color:var(--muted);font-size:12px'>No data yet.</p>"}
    ${peakHour ? `<div style="margin-top:14px;font-size:11px;color:var(--muted)">Peak hour: <strong style="color:var(--accent)">${peakHour[0]}:00 UTC</strong> (${formatUSD(peakHour[1])} / 30d)</div>` : ""}
  </div>
</div>

<div class="table-section">
  <div class="section-title">Full call timeline — last 200 calls (hover = task preview)</div>
  <table>
    <thead>
      <tr>
        <th>Time (UTC)</th><th>Model</th><th>In</th><th>Out</th>
        <th>Cost</th><th>Skill</th><th>Channel</th><th>Type</th>
      </tr>
    </thead>
    <tbody>${callRows || "<tr><td colspan='8' style='color:var(--muted);text-align:center;padding:24px'>No calls yet.</td></tr>"}</tbody>
  </table>
</div>

<footer>
  <span class="footer-stat">ClawSaver <strong>v1.0</strong></span>
  <span class="footer-stat">Mode: <strong>⚡ GOD</strong></span>
  <span class="footer-stat">DB: <strong>~/.openclaw/clawsaver/costs.db</strong></span>
  <span class="footer-stat">Owner: <strong>${esc(owner)}</strong></span>
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

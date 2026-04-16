/**
 * ClawSaver v1.1 — OpenClaw Cost Tracking Plugin
 *
 * New in v1.1:
 * - God Mode: unlock with personal code → insane dashboard + extra commands
 * - Spend Limit: /clawsaver-limit $5 → agent pauses when hit
 * - Auto-updater: checks GitHub every 3 days, notifies via WhatsApp
 * - Per-call spend limit enforcement
 */

import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import cron from "node-cron";
import { createServer, type IncomingMessage, type ServerResponse } from "http";

import { openDb, insertCall, setSetting, getSetting, getSpend, getTopSkills } from "./db.js";
import { findPrice, calcCost, formatUSD } from "./pricing.js";
import { startDashboard } from "./dashboard.js";
import { buildGodHtml } from "./dashboard-godmode.js";
import { buildDigest, checkBudgets } from "./digest.js";
import { loadGodMode, activateCode, isGodMode, getGodState } from "./godmode.js";
import { checkForUpdates } from "./updater.js";
import {
  checkSpendLimit,
  setSessionLimit,
  clearSessionLimit,
  resumeAfterLimit,
  stopAfterLimit,
  formatLimitStatus,
} from "./spend-limit.js";

const DAY = 86_400_000;
const PORT = 3333;

function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function num(v: unknown): number { return typeof v === "number" && isFinite(v) ? v : 0; }

// ── Dashboard server (regular + God Mode) ─────────────────────────────────────
function startCombinedDashboard(db: ReturnType<typeof openDb>): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    try {
      const html = isGodMode() ? buildGodHtml(db) : buildRegularHtml(db);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end("ClawSaver error — check gateway logs.");
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") console.error("[ClawSaver] server error:", err);
    else console.warn(`[ClawSaver] Port ${PORT} in use.`);
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[ClawSaver] Dashboard → http://localhost:${PORT}`);
  });
}

// Import the regular dashboard builder
import { buildHtml as buildRegularHtml } from "./dashboard.js";

// ── Plugin entry ──────────────────────────────────────────────────────────────
export default definePluginEntry({
  id: "clawsaver",
  name: "ClawSaver",
  description: "Track every API call cost. God Mode available.",

  async register(api: OpenClawPluginApi) {
    const db = openDb();
    const log = api.logger;

    // Load God Mode state from disk
    await loadGodMode().catch(() => {});

    log.info(`DB: ~/.openclaw/clawsaver/costs.db`);
    log.info(`God Mode: ${isGodMode() ? `⚡ ACTIVE (${getGodState().owner})` : "locked"}`);

    // ── Hook: capture every LLM response ───────────────────────────────────
    api.on("llm_output", async (event: Record<string, unknown>) => {
      try {
        const usage = event.usage as Record<string, unknown> | undefined;
        if (!usage) return;

        const model = str(event.model ?? event.modelId ?? "");
        const inputTokens  = num(usage.input  ?? usage.inputTokens  ?? usage.input_tokens);
        const outputTokens = num(usage.output ?? usage.outputTokens ?? usage.output_tokens);
        const cacheReadTokens = num(usage.cacheRead ?? usage.cacheReadInputTokens ?? usage.cache_read_tokens ?? 0);

        const price = findPrice(model);
        const costUsd = price
          ? calcCost(inputTokens, outputTokens, cacheReadTokens, price)
          : 0;

        const meta = event.metadata as Record<string, unknown> | undefined;
        insertCall(db, {
          ts: Date.now(),
          model: model || "unknown",
          provider: price?.provider ?? "unknown",
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_tokens: cacheReadTokens,
          cost_usd: costUsd,
          session_id: str(event.sessionId ?? event.session_id ?? ""),
          skill_name: str(meta?.skillName ?? meta?.skill_name ?? "") || null,
          channel: str(meta?.channel ?? "") || null,
          task_snippet: str(event.userMessage ?? meta?.userMessage ?? "").slice(0, 120) || null,
          is_heartbeat: !!(event.isHeartbeat ?? meta?.isHeartbeat ?? false) ? 1 : 0,
        });

        // Check spend limit after every call
        const limitCheck = checkSpendLimit(db);
        if (limitCheck.message && limitCheck.reason === "limit_hit") {
          api.sendMessage?.({ text: limitCheck.message, target: "last" });
        } else if (limitCheck.message && limitCheck.reason === "limit_warning") {
          api.sendMessage?.({ text: limitCheck.message, target: "last" });
        }
      } catch (err) {
        log.error("call log error: " + String(err));
      }
    });

    // ── Tool: cost report ──────────────────────────────────────────────────
    api.registerTool({
      name: "clawsaver_report",
      description: 'Show API cost breakdown. Use when user asks "how much did I spend?", "where did my money go?", "what costs the most?"',
      parameters: {
        type: "object" as const,
        properties: {
          period: { type: "string", enum: ["today", "week", "month"] },
        },
        required: ["period"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const period = str(params.period) as "today" | "week" | "month";
        const ms = { today: DAY, week: 7*DAY, month: 30*DAY };
        const since = Date.now() - (ms[period] ?? DAY);
        const spend = getSpend(db, since);
        const skills = getTopSkills(db, since, 6);
        const lines = skills.map((s) => `  • ${s.skill}: ${formatUSD(s.cost_usd)} (${s.call_count} calls)`).join("\n");
        const godNote = isGodMode() ? "\n⚡ God Mode active — full data at localhost:3333" : "\nDashboard: http://localhost:3333";
        return {
          content: [{
            type: "text" as const,
            text: `ClawSaver — ${period}\nTotal: ${formatUSD(spend.total_usd)} · ${spend.call_count} calls\n\n${lines}${godNote}`,
          }],
        };
      },
    });

    // ── Tool: settings ─────────────────────────────────────────────────────
    api.registerTool({
      name: "clawsaver_settings",
      description: 'Update settings. Use for: "set daily budget to $10", "set monthly limit to $50", "alert at 90%"',
      parameters: {
        type: "object" as const,
        properties: {
          setting: { type: "string", enum: ["budgetDailyUsd","budgetMonthlyUsd","alertAt","digestEveryDays","digestHour"] },
          value: { type: "string" },
        },
        required: ["setting", "value"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        setSetting(db, str(params.setting), str(params.value));
        return { content: [{ type: "text" as const, text: `ClawSaver: ${params.setting} → ${params.value}` }] };
      },
    });

    // ── Commands ───────────────────────────────────────────────────────────

    api.registerCommand({
      name: "clawsaver-status",
      description: "Quick cost summary",
      handler: async () => {
        const today = getSpend(db, Date.now() - DAY);
        const week  = getSpend(db, Date.now() - 7*DAY);
        const godLine = isGodMode() ? `\n⚡ God Mode: ${getGodState().owner}` : "";
        return {
          text: `ClawSaver Status${godLine}\nToday: ${formatUSD(today.total_usd)} (${today.call_count} calls)\n7 days: ${formatUSD(week.total_usd)} (${week.call_count} calls)\nDashboard: http://localhost:${PORT}`,
        };
      },
    });

    api.registerCommand({
      name: "clawsaver-digest",
      description: "Send daily cost digest",
      handler: async () => {
        const days = parseInt(getSetting(db, "digestEveryDays", "1"), 10);
        return { text: buildDigest(db, days) };
      },
    });

    api.registerCommand({
      name: "clawsaver-budget",
      description: "Budget status and alerts",
      handler: async () => {
        const alert = checkBudgets(db);
        if (alert) return { text: alert.message };
        const daily = parseFloat(getSetting(db, "budgetDailyUsd", "0"));
        const month = parseFloat(getSetting(db, "budgetMonthlyUsd", "0"));
        if (!daily && !month) return { text: "No budgets set.\nTell your agent: \"set my daily budget to $10\"" };
        const d = getSpend(db, Date.now() - DAY).total_usd;
        const m = getSpend(db, Date.now() - 30*DAY).total_usd;
        const lines = ["ClawSaver Budget"];
        if (daily) lines.push(`Daily:   ${formatUSD(d)} / ${formatUSD(daily)} (${Math.round(d/daily*100)}%)`);
        if (month) lines.push(`Monthly: ${formatUSD(m)} / ${formatUSD(month)} (${Math.round(m/month*100)}%)`);
        return { text: lines.join("\n") };
      },
    });

    // ── Spend limit commands ────────────────────────────────────────────────

    api.registerCommand({
      name: "clawsaver-limit",
      description: "Set a session spend limit. Usage: /clawsaver-limit 5 (sets $5 limit)",
      handler: async (args) => {
        const raw = str(args?.args ?? args?.text ?? "").trim();
        const amount = parseFloat(raw.replace(/\$/g, ""));
        if (isNaN(amount) || amount < 0) {
          return { text: `Usage: /clawsaver-limit 5\nThis will pause your agent when it reaches $5 in this session.` };
        }
        if (amount === 0) {
          clearSessionLimit(db);
          return { text: "Session limit cleared." };
        }
        setSessionLimit(db, amount);
        return { text: `✅ Session limit set to ${formatUSD(amount)}.\nYour agent will pause and ask permission when it hits this amount.\nCheck: /clawsaver-limit-status` };
      },
    });

    api.registerCommand({
      name: "clawsaver-limit-status",
      description: "Check current session limit",
      handler: async () => ({ text: formatLimitStatus(db) }),
    });

    api.registerCommand({
      name: "clawsaver-continue",
      description: "Continue after hitting spend limit",
      handler: async () => {
        resumeAfterLimit(db);
        return { text: "✅ Limit override — agent will continue. Limit has been removed." };
      },
    });

    api.registerCommand({
      name: "clawsaver-stop",
      description: "Stop agent after hitting spend limit",
      handler: async () => {
        stopAfterLimit(db);
        return { text: "🛑 Agent stopped. Session limit cleared. Set a new one with /clawsaver-limit" };
      },
    });

    // ── God Mode commands ───────────────────────────────────────────────────

    api.registerCommand({
      name: "clawsaver-unlock",
      description: "Activate God Mode with a personal code",
      handler: async (args) => {
        const code = str(args?.args ?? args?.text ?? "").trim();
        if (!code) {
          return { text: "Usage: /clawsaver-unlock YOUR-CODE\nDon't have a code? Contact the developer." };
        }
        const result = await activateCode(code);
        if (result.success) {
          return { text: `${result.message}\n\nRefresh http://localhost:${PORT} to see your God Mode dashboard. ⚡` };
        }
        return { text: `❌ ${result.message}` };
      },
    });

    api.registerCommand({
      name: "clawsaver-godstatus",
      description: "Check God Mode status",
      handler: async () => {
        const state = getGodState();
        if (state.active) {
          return { text: `⚡ God Mode: ACTIVE\nOwner: ${state.owner}\nTier: ${state.tier}\nDashboard: http://localhost:${PORT}` };
        }
        return { text: "God Mode: locked\nUnlock: /clawsaver-unlock YOUR-CODE" };
      },
    });

    // ── Auto-update check command ───────────────────────────────────────────

    api.registerCommand({
      name: "clawsaver-update",
      description: "Check for ClawSaver updates",
      handler: async () => {
        const result = await checkForUpdates(true);
        if (!result) return { text: "✅ ClawSaver is up to date (v1.0.0)" };
        return { text: result.message };
      },
    });

    // ── Scheduled jobs ──────────────────────────────────────────────────────

    // Daily digest
    cron.schedule(`0 ${getSetting(db, "digestHour", "8")} * * *`, () => {
      const days = parseInt(getSetting(db, "digestEveryDays", "1"), 10);
      log.info("Digest: " + buildDigest(db, days).slice(0, 100));
    });

    // Budget check every 15 min
    cron.schedule("*/15 * * * *", () => {
      const alert = checkBudgets(db);
      if (alert) log.warn("Budget: " + alert.message.slice(0, 80));
    });

    // Update check every 3 days (at 9am)
    cron.schedule("0 9 */3 * *", async () => {
      const update = await checkForUpdates();
      if (update) {
        log.info("Update available: " + update.latestVersion);
        api.sendMessage?.({ text: update.message, target: "last" });
      }
    });

    // ── Start dashboard ─────────────────────────────────────────────────────
    startCombinedDashboard(db);

    log.info("ClawSaver v1.1 loaded ✓");
    log.info(`God Mode: ${isGodMode() ? "⚡ ACTIVE" : "locked (use /clawsaver-unlock)"}`);
    log.info("Commands: /clawsaver-status · /clawsaver-digest · /clawsaver-limit · /clawsaver-unlock");
  },
});

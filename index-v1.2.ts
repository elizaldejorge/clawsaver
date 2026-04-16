/**
 * ClawSaver v1.2 — OpenClaw Cost Tracking Plugin
 *
 * v1.2 adds:
 * - Click any row in God Mode dashboard → opens full call detail in new tab
 * - See user message, agent reply, tools used, token + cost breakdown
 * - message_received hook captures user messages before LLM call
 */

import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import cron from "node-cron";

import { openDb, insertCall, setSetting, getSetting, getSpend, getTopSkills } from "./db.js";
import { findPrice, calcCost, formatUSD } from "./pricing.js";
import { buildHtml as buildRegularHtml } from "./dashboard.js";
import { buildGodHtml } from "./dashboard-godmode.js";
import { buildDigest, checkBudgets } from "./digest.js";
import { loadGodMode, activateCode, isGodMode, getGodState } from "./godmode.js";
import { checkForUpdates } from "./updater.js";
import {
  checkSpendLimit, setSessionLimit, clearSessionLimit,
  resumeAfterLimit, stopAfterLimit, formatLimitStatus,
} from "./spend-limit.js";
import {
  migrateCallDetails, storePendingMessage, popPendingMessage,
  storeCallDetail, buildDetailHtml,
} from "./call-detail.js";

const DAY = 86_400_000;
const PORT = 3333;

function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function num(v: unknown): number { return typeof v === "number" && isFinite(v) ? v : 0; }

// ── Dashboard server ──────────────────────────────────────────────────────────
function startCombinedDashboard(db: ReturnType<typeof openDb>): void {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

      // Call detail page — God Mode only
      if (url.pathname.startsWith("/call/") && isGodMode()) {
        const callId = parseInt(url.pathname.split("/")[2] ?? "0", 10);
        const html = buildDetailHtml(db, callId);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

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

// ── Plugin entry ──────────────────────────────────────────────────────────────
export default definePluginEntry({
  id: "clawsaver",
  name: "ClawSaver",
  description: "Track every API call cost. God Mode with full call inspector.",

  async register(api: OpenClawPluginApi) {
    const db = openDb();
    const log = api.logger;

    // Run migrations (adds new tables if not exist, safe to run every time)
    migrateCallDetails(db);

    // Load God Mode state
    await loadGodMode().catch(() => {});

    log.info(`DB: ~/.openclaw/clawsaver/costs.db`);
    log.info(`God Mode: ${isGodMode() ? `⚡ ACTIVE (${getGodState().owner})` : "locked"}`);

    // ── Hook: capture user message BEFORE LLM call ────────────────────────
    api.on("message_received", async (event: Record<string, unknown>) => {
      try {
        const sessionId = str(event.sessionId ?? event.session_id ?? "");
        const body = str(event.body ?? event.text ?? event.content ?? "");
        if (sessionId && body) {
          storePendingMessage(db, sessionId, body);
        }
      } catch { /* never crash */ }
    });

    // ── Hook: capture every LLM response ─────────────────────────────────
    api.on("llm_output", async (event: Record<string, unknown>) => {
      try {
        const usage = event.usage as Record<string, unknown> | undefined;
        if (!usage) return;

        const model = str(event.model ?? event.modelId ?? "");
        const inputTokens     = num(usage.input  ?? usage.inputTokens  ?? usage.input_tokens);
        const outputTokens    = num(usage.output ?? usage.outputTokens ?? usage.output_tokens);
        const cacheReadTokens = num(usage.cacheRead ?? usage.cacheReadInputTokens ?? usage.cache_read_tokens ?? 0);

        const price  = findPrice(model);
        const costUsd = price ? calcCost(inputTokens, outputTokens, cacheReadTokens, price) : 0;

        const meta       = event.metadata as Record<string, unknown> | undefined;
        const sessionId  = str(event.sessionId ?? event.session_id ?? "");
        const skillName  = str(meta?.skillName ?? meta?.skill_name ?? "") || null;
        const channel    = str(meta?.channel ?? "") || null;
        const isHeartbeat = !!(event.isHeartbeat ?? meta?.isHeartbeat ?? false);
        const taskSnippet = str(event.userMessage ?? meta?.userMessage ?? "").slice(0, 120) || null;

        insertCall(db, {
          ts: Date.now(),
          model: model || "unknown",
          provider: price?.provider ?? "unknown",
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_tokens: cacheReadTokens,
          cost_usd: costUsd,
          session_id: sessionId,
          skill_name: skillName,
          channel,
          task_snippet: taskSnippet,
          is_heartbeat: isHeartbeat ? 1 : 0,
        });

        // Store full detail for God Mode call inspector
        const lastId = (db.prepare("SELECT last_insert_rowid() as id").get() as { id: number }).id;
        const userMsg    = popPendingMessage(db, sessionId);
        const agentReply = (event.assistantTexts as string[] | undefined)?.[0] ?? null;
        const lastAssist = event.lastAssistant as Record<string, unknown> | undefined;
        const rawCostObj = (lastAssist?.usage as Record<string, unknown> | undefined)?.cost;

        // Extract tool calls if any
        const content  = lastAssist?.content as Array<Record<string, unknown>> | undefined;
        const toolUses = content?.filter((b) => b.type === "tool_use") ?? [];
        const toolsJson = toolUses.length > 0
          ? JSON.stringify(toolUses.map((t) => ({
              name:   str(t.name),
              input:  JSON.stringify(t.input ?? {}).slice(0, 500),
              output: "see agent reply",
            })))
          : null;

        storeCallDetail(db, {
          callId:               lastId,
          sessionId,
          userMessage:          userMsg,
          agentReply,
          systemPromptSnippet:  null,
          toolsUsed:            toolsJson,
          rawCost:              rawCostObj ? JSON.stringify(rawCostObj) : null,
        });

        // Check spend limit
        const limitCheck = checkSpendLimit(db);
        if (limitCheck.message) {
          api.sendMessage?.({ text: limitCheck.message, target: "last" });
        }

      } catch (err) {
        log.error("call log error: " + String(err));
      }
    });

    // ── Tool: cost report ─────────────────────────────────────────────────
    api.registerTool({
      name: "clawsaver_report",
      description: 'Show API cost breakdown. Use when user asks "how much did I spend?", "where did my money go?", "what costs the most?"',
      parameters: {
        type: "object" as const,
        properties: { period: { type: "string", enum: ["today", "week", "month"] } },
        required: ["period"],
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const period = str(params.period) as "today" | "week" | "month";
        const ms = { today: DAY, week: 7*DAY, month: 30*DAY };
        const since = Date.now() - (ms[period] ?? DAY);
        const spend  = getSpend(db, since);
        const skills = getTopSkills(db, since, 6);
        const lines  = skills.map((s) => `  • ${s.skill}: ${formatUSD(s.cost_usd)} (${s.call_count} calls)`).join("\n");
        const godNote = isGodMode()
          ? "\n⚡ God Mode — click any row at localhost:3333 to see full call details"
          : "\nDashboard: http://localhost:3333";
        return {
          content: [{
            type: "text" as const,
            text: `ClawSaver — ${period}\nTotal: ${formatUSD(spend.total_usd)} · ${spend.call_count} calls\n\n${lines}${godNote}`,
          }],
        };
      },
    });

    // ── Tool: settings ────────────────────────────────────────────────────
    api.registerTool({
      name: "clawsaver_settings",
      description: 'Update settings. "set daily budget to $10", "alert at 90%", "digest every 2 days"',
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

    // ── Commands ──────────────────────────────────────────────────────────

    api.registerCommand({
      name: "clawsaver-status",
      description: "Quick cost summary",
      handler: async () => {
        const today = getSpend(db, Date.now() - DAY);
        const week  = getSpend(db, Date.now() - 7*DAY);
        const godLine = isGodMode() ? `\n⚡ God Mode: ${getGodState().owner}` : "";
        return {
          text: `ClawSaver${godLine}\nToday: ${formatUSD(today.total_usd)} (${today.call_count} calls)\n7 days: ${formatUSD(week.total_usd)} (${week.call_count} calls)\nDashboard: http://localhost:${PORT}`,
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
      description: "Budget status",
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

    // Spend limit commands
    api.registerCommand({
      name: "clawsaver-limit",
      description: "Set session spend limit. Usage: /clawsaver-limit 5",
      handler: async (args) => {
        const raw = str((args as Record<string,unknown>)?.args ?? (args as Record<string,unknown>)?.text ?? "").trim();
        const amount = parseFloat(raw.replace(/\$/g, ""));
        if (isNaN(amount) || amount < 0) return { text: "Usage: /clawsaver-limit 5\nSets a $5 session limit. Agent pauses when hit." };
        if (amount === 0) { clearSessionLimit(db); return { text: "Session limit cleared." }; }
        setSessionLimit(db, amount);
        return { text: `✅ Session limit set to ${formatUSD(amount)}. Agent will pause and ask when hit.\nCheck: /clawsaver-limit-status` };
      },
    });

    api.registerCommand({
      name: "clawsaver-limit-status",
      description: "Check session limit",
      handler: async () => ({ text: formatLimitStatus(db) }),
    });

    api.registerCommand({
      name: "clawsaver-continue",
      description: "Continue after hitting spend limit",
      handler: async () => { resumeAfterLimit(db); return { text: "✅ Limit override — agent will continue." }; },
    });

    api.registerCommand({
      name: "clawsaver-stop",
      description: "Stop agent after hitting spend limit",
      handler: async () => { stopAfterLimit(db); return { text: "🛑 Agent stopped. Limit cleared." }; },
    });

    // God Mode commands
    api.registerCommand({
      name: "clawsaver-unlock",
      description: "Activate God Mode with personal code",
      handler: async (args) => {
        const code = str((args as Record<string,unknown>)?.args ?? (args as Record<string,unknown>)?.text ?? "").trim();
        if (!code) return { text: "Usage: /clawsaver-unlock YOUR-CODE" };
        const result = await activateCode(code);
        return { text: result.success
          ? `${result.message}\n\nRefresh http://localhost:${PORT} ⚡`
          : `❌ ${result.message}` };
      },
    });

    api.registerCommand({
      name: "clawsaver-godstatus",
      description: "Check God Mode status",
      handler: async () => {
        const s = getGodState();
        return s.active
          ? { text: `⚡ God Mode: ACTIVE\nOwner: ${s.owner}\nDashboard: http://localhost:${PORT}` }
          : { text: "God Mode: locked\nUnlock: /clawsaver-unlock YOUR-CODE" };
      },
    });

    api.registerCommand({
      name: "clawsaver-update",
      description: "Check for ClawSaver updates",
      handler: async () => {
        const result = await checkForUpdates(true);
        return result ? { text: result.message } : { text: "✅ ClawSaver is up to date (v1.2)" };
      },
    });

    // ── Cron jobs ─────────────────────────────────────────────────────────
    cron.schedule(`0 ${getSetting(db, "digestHour", "8")} * * *`, () => {
      const days = parseInt(getSetting(db, "digestEveryDays", "1"), 10);
      log.info("Digest: " + buildDigest(db, days).slice(0, 100));
    });

    cron.schedule("*/15 * * * *", () => {
      const alert = checkBudgets(db);
      if (alert) log.warn("Budget: " + alert.message.slice(0, 80));
    });

    cron.schedule("0 9 */3 * *", async () => {
      const update = await checkForUpdates();
      if (update) {
        log.info("Update available: " + update.latestVersion);
        api.sendMessage?.({ text: update.message, target: "last" });
      }
    });

    // ── Start dashboard ───────────────────────────────────────────────────
    startCombinedDashboard(db);

    log.info("ClawSaver v1.2 loaded ✓");
    log.info(`God Mode: ${isGodMode() ? "⚡ ACTIVE — click rows for full call details" : "locked"}`);
    log.info("Commands: /clawsaver-status · /clawsaver-digest · /clawsaver-limit · /clawsaver-unlock");
  },
});

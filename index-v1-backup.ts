/**
 * ClawSaver — OpenClaw Cost Tracking Plugin
 *
 * Logs every API call with real-time USD cost. Shows you exactly where
 * your money went: which skill, which model, which channel, at what time.
 *
 * All data is local. Nothing leaves your machine.
 * Dashboard: http://localhost:3333
 * Data: ~/.openclaw/clawsaver/costs.db
 */

import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import cron from "node-cron";

import { openDb, insertCall, setSetting, getSetting } from "./db.js";
import { findPrice, calcCost, formatUSD } from "./pricing.js";
import { startDashboard } from "./dashboard.js";
import { buildDigest, checkBudgets } from "./digest.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const DAY = 86_400_000;

/** Safely pull a string from an unknown event payload */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" && isFinite(v) ? v : 0;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "clawsaver",
  name: "ClawSaver",
  description:
    "Track every API call cost. See exactly where your OpenClaw money went.",

  register(api: OpenClawPluginApi) {
    const db = openDb();
    const log = api.logger;

    log.info(`DB: ~/.openclaw/clawsaver/costs.db`);

    // ── 1. Hook: capture every LLM response ────────────────────────────────
    //
    // "after_tool_call" and session/message hooks are listed in the SDK docs.
    // We use registerHook with the message_sending and agent lifecycle events.
    // The correct event for post-LLM logging is an agent lifecycle hook.
    //
    // NOTE: The exact event name that carries usage data is
    //   agent_turn_end  (fired after the model finishes a turn)
    // This is confirmed in the plugin architecture docs under "Agent lifecycle hooks".

    api.on("llm_output",
      async (event: Record<string, unknown>) => {
        try {
          const usage = event.usage as Record<string, unknown> | undefined;
          api.logger.info("llm_output event: " + JSON.stringify(event).slice(0, 500));
          if (!usage) return; // Some turns (tool-only) may have no usage

          const model = str(event.model ?? event.modelId ?? "");
          const inputTokens = num(usage.input ?? usage.inputTokens ?? usage.input_tokens);
          const outputTokens = num(usage.output ?? usage.outputTokens ?? usage.output_tokens);
          const cacheReadTokens = num(
            usage.cacheReadInputTokens ??
            usage.cache_read_tokens ??
            0
          );

          const price = findPrice(model);
          const costUsd = price
            ? calcCost(inputTokens, outputTokens, cacheReadTokens, price)
            : 0;

          // Extract metadata safely
          const meta = event.metadata as Record<string, unknown> | undefined;
          const sessionId = str(event.sessionId ?? event.session_id ?? "");
          const skillName =
            str(meta?.skillName ?? meta?.skill_name ?? "") || null;
          const channel = str(meta?.channel ?? "") || null;
          const isHeartbeat =
            !!(event.isHeartbeat ?? meta?.isHeartbeat ?? false);

          // Grab first 120 chars of the user message for the hover tooltip
          const userMsg = str(
            event.userMessage ??
            meta?.userMessage ??
            ""
          );
          const taskSnippet = userMsg.slice(0, 120) || null;

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

          if (costUsd > 0.01) {
            log.debug(
              `logged: ${model} in=${inputTokens} out=${outputTokens} → ${formatUSD(costUsd)}`
            );
          }
        } catch (err) {
          // Never crash the gateway
          log.error("failed to log API call: " + String(err));
        }
      }
    );

    // ── 2. Tool: "how much did I spend?" ──────────────────────────────────
    //
    // The correct execute signature from the SDK docs is:
    //   async execute(_callId: string, params: Record<string, unknown>)
    // returning { content: [{ type: "text", text: string }] }

    api.registerTool({
      name: "clawsaver_report",
      description:
        'Show API cost breakdown and spending summary. Use when user asks "how much did I spend?", "where did my money go?", "what is costing me the most?", "show my API costs", or any question about token costs or spending.',
      parameters: {
        type: "object" as const,
        properties: {
          period: {
            type: "string",
            enum: ["today", "week", "month"],
            description: "Time window for the report",
          },
        },
        required: ["period"],
      },
      async execute(_callId: string, params: Record<string, unknown>) {
        const period = str(params.period) as "today" | "week" | "month";
        const windows: Record<string, number> = {
          today: DAY,
          week:  7 * DAY,
          month: 30 * DAY,
        };
        const since = Date.now() - (windows[period] ?? DAY);

        const { getSpend, getTopSkills } = await import("./db.js");
        const spend  = getSpend(db, since);
        const skills = getTopSkills(db, since, 6);

        const skillLines = skills.length
          ? skills
              .map((s) => `  • ${s.skill}: ${formatUSD(s.cost_usd)} (${s.call_count} calls)`)
              .join("\n")
          : "  No data yet.";

        const text =
          `ClawSaver — ${period}\n` +
          `Total: ${formatUSD(spend.total_usd)} · ${spend.call_count} calls · ${(spend.total_tokens / 1000).toFixed(0)}k tokens\n\n` +
          `Top spenders:\n${skillLines}\n\n` +
          `Full dashboard → http://localhost:3333`;

        return { content: [{ type: "text" as const, text }] };
      },
    });

    // ── 3. Tool: update settings ──────────────────────────────────────────

    api.registerTool({
      name: "clawsaver_settings",
      description:
        "Update ClawSaver settings. Use when user says things like: " +
        '"set my daily budget to $10", "alert me at 90% of budget", ' +
        '"send digest every 2 days", "set monthly limit to $50".',
      parameters: {
        type: "object" as const,
        properties: {
          setting: {
            type: "string",
            enum: [
              "budgetDailyUsd",
              "budgetMonthlyUsd",
              "alertAt",
              "digestEveryDays",
              "digestHour",
            ],
            description: "Which setting to change",
          },
          value: {
            type: "string",
            description: "New value (number as string)",
          },
        },
        required: ["setting", "value"],
      },
      async execute(_callId: string, params: Record<string, unknown>) {
        const setting = str(params.setting);
        const value   = str(params.value);

        const allowed = [
          "budgetDailyUsd",
          "budgetMonthlyUsd",
          "alertAt",
          "digestEveryDays",
          "digestHour",
        ];
        if (!allowed.includes(setting)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Unknown setting: ${setting}. Valid options: ${allowed.join(", ")}`,
              },
            ],
          };
        }

        setSetting(db, setting, value);

        // Re-schedule digest if timing changed
        if (setting === "digestEveryDays" || setting === "digestHour") {
          scheduleDigest();
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `ClawSaver: ${setting} → ${value}`,
            },
          ],
        };
      },
    });

    // ── 4. Cron: daily digest + budget alerts ─────────────────────────────
    //
    // We use node-cron directly. The digest is sent via api.runtime.subagent
    // or — more simply — we use the agent's built-in sendMessage if available.
    // Since OpenClaw doesn't expose a direct "send to user" from plugins yet,
    // we use registerCommand to let the agent trigger the digest on schedule,
    // and fall back to logging for now. The real send path is via the agent
    // running a cron job that calls the tool.
    //
    // NOTE: The cleanest pattern is to expose a /clawsaver-digest command that
    // the user can add to their HEARTBEAT.md or cron config.

    let digestJob: ReturnType<typeof cron.schedule> | null = null;

    function scheduleDigest() {
      if (digestJob) { digestJob.stop(); digestJob = null; }

      const hour = parseInt(getSetting(db, "digestHour", "8"), 10);
      const everyDays = parseInt(getSetting(db, "digestEveryDays", "1"), 10);

      // Build a cron expression: at {hour}:00, every {everyDays} days
      // Simple approach: run daily, but only send every N days
      digestJob = cron.schedule(`0 ${hour} * * *`, () => {
        try {
          const msg = buildDigest(db, everyDays);
          // Log to gateway — the agent's cron will also call /clawsaver-digest
          // if the user adds it to their schedule
          log.info("Digest ready (use /clawsaver-digest to send):\n" + msg);
        } catch (err) {
          log.error("digest error: " + String(err));
        }
      });
    }

    scheduleDigest();

    // Budget alert: check every 15 minutes
    cron.schedule("*/15 * * * *", () => {
      try {
        const alert = checkBudgets(db);
        if (alert) {
          log.warn("Budget alert: " + alert.message);
          // Same pattern — logged. User sees it via /clawsaver-status or cron.
        }
      } catch (err) {
        log.error("budget check error: " + String(err));
      }
    });

    // ── 5. Commands: /clawsaver-status and /clawsaver-digest ─────────────

    api.registerCommand({
      name: "clawsaver-status",
      description: "Show a quick cost summary for today and this week",
      handler: async () => {
        const { getSpend } = await import("./db.js");
        const today = getSpend(db, Date.now() - DAY);
        const week  = getSpend(db, Date.now() - 7 * DAY);
        return {
          text:
            `ClawSaver Status\n` +
            `Today:    ${formatUSD(today.total_usd)} (${today.call_count} calls)\n` +
            `7 days:   ${formatUSD(week.total_usd)} (${week.call_count} calls)\n` +
            `Dashboard: http://localhost:3333`,
        };
      },
    });

    api.registerCommand({
      name: "clawsaver-digest",
      description: "Send the daily cost digest now (add to HEARTBEAT.md for scheduled delivery)",
      handler: async () => {
        const everyDays = parseInt(getSetting(db, "digestEveryDays", "1"), 10);
        const text = buildDigest(db, everyDays);
        return { text };
      },
    });

    api.registerCommand({
      name: "clawsaver-budget",
      description: "Check current budget status",
      handler: async () => {
        const alert = checkBudgets(db);
        if (alert) return { text: alert.message };

        const dailyBudget = parseFloat(getSetting(db, "budgetDailyUsd", "0"));
        const monthBudget = parseFloat(getSetting(db, "budgetMonthlyUsd", "0"));

        if (dailyBudget === 0 && monthBudget === 0) {
          return {
            text: "No budgets set.\nUse: clawsaver_settings budgetDailyUsd 10\nOr ask your agent: \"set my daily budget to $10\"",
          };
        }

        const { getSpend } = await import("./db.js");
        const daySpend   = getSpend(db, Date.now() - DAY).total_usd;
        const monthSpend = getSpend(db, Date.now() - 30 * DAY).total_usd;

        const lines: string[] = ["ClawSaver Budget Status"];
        if (dailyBudget > 0) {
          const pct = Math.round((daySpend / dailyBudget) * 100);
          lines.push(`Daily:   ${formatUSD(daySpend)} / ${formatUSD(dailyBudget)} (${pct}%)`);
        }
        if (monthBudget > 0) {
          const pct = Math.round((monthSpend / monthBudget) * 100);
          lines.push(`Monthly: ${formatUSD(monthSpend)} / ${formatUSD(monthBudget)} (${pct}%)`);
        }

        return { text: lines.join("\n") };
      },
    });

    // ── 6. Start dashboard ────────────────────────────────────────────────
    startDashboard(db);

    log.info("ClawSaver loaded ✓");
    log.info("Commands: /clawsaver-status · /clawsaver-digest · /clawsaver-budget");
    log.info("Dashboard: http://localhost:3333");
  },
});

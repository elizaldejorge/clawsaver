/**
 * ClawSaver — Digest & alert module
 * Builds the daily "where did my money go" message sent to the user's channel.
 */

import type Database from "better-sqlite3";
import {
  getSpend,
  getTopSkills,
  getSetting,
  wasAlertedRecently,
  logAlert,
} from "./db.js";
import { formatUSD } from "./pricing.js";

const DAY = 86_400_000;
const HOUR = 3_600_000;

// ── Digest message ─────────────────────────────────────────────────────────

export function buildDigest(db: Database.Database, daysBack = 1): string {
  const since = Date.now() - daysBack * DAY;
  const label = daysBack === 1 ? "Yesterday" : `Last ${daysBack} days`;

  const spend = getSpend(db, since);
  if (spend.call_count === 0) {
    return `📊 *ClawSaver — ${label}*\nNo API calls recorded.`;
  }

  const skills = getTopSkills(db, since, 6);

  // Heartbeat-specific spend
  const hbRow = db.prepare(`
    SELECT COALESCE(SUM(cost_usd), 0) AS c, COUNT(*) AS n
    FROM calls WHERE ts >= ? AND is_heartbeat = 1
  `).get(since) as { c: number; n: number };

  const skillLines = skills
    .map((s) => `  • ${s.skill}: ${formatUSD(s.cost_usd)} (${s.call_count} calls)`)
    .join("\n");

  let msg = `📊 *ClawSaver — ${label}*\n`;
  msg += `💰 Total: *${formatUSD(spend.total_usd)}* · ${spend.call_count} calls · ${(spend.total_tokens / 1000).toFixed(0)}k tokens\n\n`;
  msg += `*Top spenders:*\n${skillLines}\n`;

  if (hbRow.n > 0 && hbRow.c > 0.1) {
    msg += `\n⚠️ *Heartbeats:* ${hbRow.n} calls = ${formatUSD(hbRow.c)}`;
    msg += `\n  → Tip: set a cheap model for heartbeats to cut this 80%`;
  }

  msg += `\n\n_Dashboard: http://localhost:3333_`;
  return msg;
}

// ── Budget alerts ─────────────────────────────────────────────────────────

export interface AlertResult {
  triggered: boolean;
  message: string;
}

export function checkBudgets(db: Database.Database): AlertResult | null {
  const dailyBudget = parseFloat(getSetting(db, "budgetDailyUsd", "0"));
  const monthlyBudget = parseFloat(getSetting(db, "budgetMonthlyUsd", "0"));
  const alertAt = parseFloat(getSetting(db, "alertAt", "0.8"));

  const daySpend = getSpend(db, Date.now() - DAY).total_usd;
  const monthSpend = getSpend(db, Date.now() - 30 * DAY).total_usd;

  const check = (
    spend: number,
    budget: number,
    label: string,
    alertKey: string
  ): AlertResult | null => {
    if (budget <= 0) return null;
    if (spend < budget * alertAt) return null;
    if (wasAlertedRecently(db, alertKey, 3 * HOUR)) return null;

    const pct = Math.round((spend / budget) * 100);
    const remaining = Math.max(0, budget - spend);
    const msg =
      `🚨 *ClawSaver Budget Alert*\n` +
      `You've used *${pct}%* of your ${label} budget.\n` +
      `Spent: ${formatUSD(spend)} / ${formatUSD(budget)} ` +
      `(${formatUSD(remaining)} remaining)\n` +
      `_Dashboard: http://localhost:3333_`;

    logAlert(db, alertKey, msg);
    return { triggered: true, message: msg };
  };

  return (
    check(daySpend, dailyBudget, "daily", "daily_budget") ??
    check(monthSpend, monthlyBudget, "monthly", "monthly_budget")
  );
}

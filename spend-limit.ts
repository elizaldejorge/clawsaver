/**
 * ClawSaver — Spend Limit Enforcer
 *
 * Set a limit: /clawsaver-limit $5
 * When the limit is hit, the agent pauses and asks permission to continue.
 * User replies "continue" or "stop" via WhatsApp/Telegram.
 */

import type Database from "better-sqlite3";
import { getSetting, setSetting, getSpend, logAlert, wasAlertedRecently } from "./db.js";
import { formatUSD } from "./pricing.js";

const SESSION_START = Date.now();

export interface LimitCheckResult {
  blocked: boolean;
  reason: string | null;
  message: string | null;
}

export function getSessionLimit(db: Database.Database): number {
  return parseFloat(getSetting(db, "sessionLimitUsd", "0"));
}

export function setSessionLimit(db: Database.Database, usd: number) {
  setSetting(db, "sessionLimitUsd", String(usd));
  setSetting(db, "sessionLimitStart", String(SESSION_START));
  setSetting(db, "sessionLimitPaused", "false");
  setSetting(db, "sessionLimitOverride", "false");
}

export function clearSessionLimit(db: Database.Database) {
  setSetting(db, "sessionLimitUsd", "0");
  setSetting(db, "sessionLimitPaused", "false");
  setSetting(db, "sessionLimitOverride", "false");
}

export function isLimitPaused(db: Database.Database): boolean {
  return getSetting(db, "sessionLimitPaused", "false") === "true";
}

export function resumeAfterLimit(db: Database.Database) {
  setSetting(db, "sessionLimitPaused", "false");
  setSetting(db, "sessionLimitOverride", "true");
}

export function stopAfterLimit(db: Database.Database) {
  setSetting(db, "sessionLimitPaused", "false");
  setSetting(db, "sessionLimitOverride", "false");
  setSetting(db, "sessionLimitUsd", "0"); // clear limit after stopping
}

export function checkSpendLimit(db: Database.Database): LimitCheckResult {
  const limit = getSessionLimit(db);
  if (limit <= 0) return { blocked: false, reason: null, message: null };

  const override = getSetting(db, "sessionLimitOverride", "false") === "true";
  if (override) return { blocked: false, reason: null, message: null };

  const paused = isLimitPaused(db);
  if (paused) {
    return {
      blocked: true,
      reason: "limit_paused",
      message: "Agent paused — waiting for your response on WhatsApp/Telegram.",
    };
  }

  const sessionStart = parseInt(getSetting(db, "sessionLimitStart", String(SESSION_START)), 10);
  const spend = getSpend(db, sessionStart).total_usd;

  // Warning at 80%
  if (spend >= limit * 0.8 && spend < limit) {
    if (!wasAlertedRecently(db, "limit_warning", 30 * 60 * 1000)) {
      logAlert(db, "limit_warning",
        `⚠️ Approaching limit: ${formatUSD(spend)} / ${formatUSD(limit)}`
      );
      return {
        blocked: false,
        reason: "limit_warning",
        message:
          `⚠️ *ClawSaver Warning*\n` +
          `You've used ${formatUSD(spend)} of your ${formatUSD(limit)} session limit.\n` +
          `_Agent will pause at the limit._`,
      };
    }
  }

  // Hit limit — pause and ask
  if (spend >= limit) {
    setSetting(db, "sessionLimitPaused", "true");
    logAlert(db, "limit_hit",
      `🛑 Session limit hit: ${formatUSD(spend)} / ${formatUSD(limit)}`
    );
    return {
      blocked: true,
      reason: "limit_hit",
      message:
        `🛑 *ClawSaver — Session Limit Reached*\n` +
        `You've spent *${formatUSD(spend)}* this session (limit: ${formatUSD(limit)}).\n\n` +
        `Reply with:\n` +
        `• */clawsaver-continue* — keep going (removes limit)\n` +
        `• */clawsaver-stop* — stop the agent\n\n` +
        `_Agent is paused until you decide._`,
    };
  }

  return { blocked: false, reason: null, message: null };
}

export function formatLimitStatus(db: Database.Database): string {
  const limit = getSessionLimit(db);
  if (limit <= 0) return "No session limit set.\nSet one: /clawsaver-limit 5";

  const sessionStart = parseInt(getSetting(db, "sessionLimitStart", String(SESSION_START)), 10);
  const spend = getSpend(db, sessionStart).total_usd;
  const pct = Math.round((spend / limit) * 100);
  const paused = isLimitPaused(db);
  const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));

  return (
    `💰 Session Limit Status\n` +
    `${bar} ${pct}%\n` +
    `Spent: ${formatUSD(spend)} / ${formatUSD(limit)}\n` +
    (paused ? `\n⏸ Agent is PAUSED — reply /clawsaver-continue or /clawsaver-stop` : "")
  );
}

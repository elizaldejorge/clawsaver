/**
 * ClawSaver — Database module
 * All storage is local: ~/.openclaw/clawsaver/costs.db
 * Nothing ever leaves the machine.
 */

import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const DATA_DIR = join(homedir(), ".openclaw", "clawsaver");
export const DB_PATH = join(DATA_DIR, "costs.db");

export interface CallRecord {
  id?: number;
  ts: number;           // unix ms
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  session_id: string;
  skill_name: string | null;
  channel: string | null;
  task_snippet: string | null; // first 120 chars of user message
  is_heartbeat: 0 | 1;
}

export interface SettingRow {
  key: string;
  value: string;
}

export function openDb(): Database.Database {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      ts               INTEGER NOT NULL,
      model            TEXT    NOT NULL,
      provider         TEXT    NOT NULL DEFAULT '',
      input_tokens     INTEGER NOT NULL DEFAULT 0,
      output_tokens    INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd         REAL    NOT NULL DEFAULT 0,
      session_id       TEXT    NOT NULL DEFAULT '',
      skill_name       TEXT,
      channel          TEXT,
      task_snippet     TEXT,
      is_heartbeat     INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_ts    ON calls(ts);
    CREATE INDEX IF NOT EXISTS idx_model ON calls(model);
    CREATE INDEX IF NOT EXISTS idx_skill ON calls(skill_name);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        INTEGER NOT NULL,
      kind      TEXT    NOT NULL,
      message   TEXT    NOT NULL
    );
  `);

  return db;
}

// ── Queries ─────────────────────────────────────────────────────────────────

export function insertCall(db: Database.Database, r: Omit<CallRecord, "id">) {
  db.prepare(`
    INSERT INTO calls
      (ts, model, provider, input_tokens, output_tokens, cache_read_tokens,
       cost_usd, session_id, skill_name, channel, task_snippet, is_heartbeat)
    VALUES
      (@ts, @model, @provider, @input_tokens, @output_tokens, @cache_read_tokens,
       @cost_usd, @session_id, @skill_name, @channel, @task_snippet, @is_heartbeat)
  `).run(r);
}

export interface SpendRow {
  total_usd: number;
  call_count: number;
  total_tokens: number;
}

export function getSpend(db: Database.Database, sinceMs: number): SpendRow {
  return db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0)                        AS total_usd,
      COUNT(*)                                           AS call_count,
      COALESCE(SUM(input_tokens + output_tokens), 0)    AS total_tokens
    FROM calls WHERE ts >= ?
  `).get(sinceMs) as SpendRow;
}

export interface SkillCostRow {
  skill: string;
  cost_usd: number;
  call_count: number;
}

export function getTopSkills(
  db: Database.Database,
  sinceMs: number,
  limit = 8
): SkillCostRow[] {
  return db.prepare(`
    SELECT
      COALESCE(skill_name, 'direct') AS skill,
      SUM(cost_usd)                  AS cost_usd,
      COUNT(*)                       AS call_count
    FROM calls
    WHERE ts >= ?
    GROUP BY skill_name
    ORDER BY cost_usd DESC
    LIMIT ?
  `).all(sinceMs, limit) as SkillCostRow[];
}

export interface RecentCallRow {
  id: number;
  ts: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  skill: string;
  channel: string;
  task_snippet: string | null;
  is_heartbeat: number;
}

export function getRecentCalls(
  db: Database.Database,
  limit = 100
): RecentCallRow[] {
  return db.prepare(`
    SELECT
      id, ts, model,
      input_tokens, output_tokens, cost_usd,
      COALESCE(skill_name, 'direct') AS skill,
      COALESCE(channel, '—')         AS channel,
      task_snippet,
      is_heartbeat
    FROM calls
    ORDER BY ts DESC
    LIMIT ?
  `).all(limit) as RecentCallRow[];
}

export function getSetting(
  db: Database.Database,
  key: string,
  fallback: string
): string {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(db: Database.Database, key: string, value: string) {
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"
  ).run(key, value);
}

export function wasAlertedRecently(
  db: Database.Database,
  kind: string,
  windowMs: number
): boolean {
  const row = db
    .prepare(
      "SELECT ts FROM alerts_log WHERE kind = ? ORDER BY ts DESC LIMIT 1"
    )
    .get(kind) as { ts: number } | undefined;
  return !!row && Date.now() - row.ts < windowMs;
}

export function logAlert(
  db: Database.Database,
  kind: string,
  message: string
) {
  db.prepare(
    "INSERT INTO alerts_log (ts, kind, message) VALUES (?, ?, ?)"
  ).run(Date.now(), kind, message);
}

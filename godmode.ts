/**
 * ClawSaver — God Mode
 *
 * Unlocked with a personal code validated against a private backend.
 * Token is stored locally and tied to this machine's ID.
 * All visual changes happen in dashboard.ts based on isGodMode().
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { hostname, cpus, networkInterfaces } from "os";
import { DATA_DIR } from "./db.js";

const TOKEN_FILE = join(DATA_DIR, "godmode.token");
// Change this to your deployed Cloudflare Worker URL after deploy
export const WORKER_URL = "https://clawsaver-godmode.elizaldejorge.workers.dev";

// ── Machine fingerprint (stable, privacy-safe) ────────────────────────────────
export function getMachineId(): string {
  const raw = [
    hostname(),
    cpus()[0]?.model ?? "cpu",
    Object.values(networkInterfaces())
      .flat()
      .find((i) => !i?.internal && i?.mac)?.mac ?? "mac",
  ].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

// ── Token storage ─────────────────────────────────────────────────────────────
interface GodToken {
  token: string;
  owner: string;
  tier: "god" | "pro";
  verifiedAt: number;
}

let _state: { active: boolean; owner: string; tier: string } = {
  active: false,
  owner: "",
  tier: "free",
};

export function isGodMode(): boolean {
  return _state.active && _state.tier === "god";
}

export function getGodState() {
  return _state;
}

export async function activateCode(code: string): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const machineId = getMachineId();
    const resp = await fetch(`${WORKER_URL}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim().toUpperCase(), machineId }),
    });

    const data = (await resp.json()) as {
      valid: boolean;
      token?: string;
      owner?: string;
      tier?: string;
      error?: string;
    };

    if (!data.valid || !data.token) {
      return { success: false, message: data.error ?? "Invalid code" };
    }

    const stored: GodToken = {
      token: data.token,
      owner: data.owner ?? "Unknown",
      tier: (data.tier as "god" | "pro") ?? "pro",
      verifiedAt: Date.now(),
    };

    writeFileSync(TOKEN_FILE, JSON.stringify(stored, null, 2));
    _state = { active: true, owner: stored.owner, tier: stored.tier };

    return {
      success: true,
      message: `🔓 God Mode activated for ${stored.owner}. Welcome to the inner circle.`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Connection error — check your internet: ${String(err)}`,
    };
  }
}

export async function loadGodMode(): Promise<void> {
  if (!existsSync(TOKEN_FILE)) return;

  try {
    const stored = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as GodToken;

    // Re-verify with backend every 7 days
    const daysSinceVerify = (Date.now() - stored.verifiedAt) / 86_400_000;
    if (daysSinceVerify > 7) {
      const machineId = getMachineId();
      const resp = await fetch(`${WORKER_URL}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: stored.token, machineId }),
      });
      const data = (await resp.json()) as { valid: boolean; tier?: string };
      if (!data.valid) {
        _state = { active: false, owner: "", tier: "free" };
        return;
      }
      // Update verified timestamp
      stored.verifiedAt = Date.now();
      writeFileSync(TOKEN_FILE, JSON.stringify(stored, null, 2));
    }

    _state = { active: true, owner: stored.owner, tier: stored.tier };
  } catch {
    // If verification fails (offline etc), use cached state
    try {
      const stored = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as GodToken;
      _state = { active: true, owner: stored.owner, tier: stored.tier };
    } catch {
      _state = { active: false, owner: "", tier: "free" };
    }
  }
}

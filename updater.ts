/**
 * ClawSaver — Auto-Update Checker
 * Checks GitHub releases every 3 days.
 * Sends a WhatsApp/Telegram message if a new version is available.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "./db.js";

const LAST_CHECK_FILE = join(DATA_DIR, "last_update_check.json");
const GITHUB_REPO = "elizaldejorge/clawsaver";
const CHECK_INTERVAL_DAYS = 3;
const CURRENT_VERSION = "1.0.0"; // bump this on each release

interface CheckState {
  lastCheckedAt: number;
  lastKnownVersion: string;
  notifiedVersion: string;
}

function loadState(): CheckState {
  if (!existsSync(LAST_CHECK_FILE)) {
    return {
      lastCheckedAt: 0,
      lastKnownVersion: CURRENT_VERSION,
      notifiedVersion: CURRENT_VERSION,
    };
  }
  try {
    return JSON.parse(readFileSync(LAST_CHECK_FILE, "utf8")) as CheckState;
  } catch {
    return {
      lastCheckedAt: 0,
      lastKnownVersion: CURRENT_VERSION,
      notifiedVersion: CURRENT_VERSION,
    };
  }
}

function saveState(state: CheckState) {
  writeFileSync(LAST_CHECK_FILE, JSON.stringify(state, null, 2));
}

function semverGt(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

export interface UpdateResult {
  hasUpdate: boolean;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes: string;
  message: string;
}

export async function checkForUpdates(force = false): Promise<UpdateResult | null> {
  const state = loadState();
  const daysSince = (Date.now() - state.lastCheckedAt) / 86_400_000;

  if (!force && daysSince < CHECK_INTERVAL_DAYS) return null;

  try {
    const resp = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
      { headers: { "User-Agent": "clawsaver-plugin" } }
    );

    if (!resp.ok) return null;

    const release = (await resp.json()) as {
      tag_name: string;
      html_url: string;
      body: string;
    };

    const latestVersion = release.tag_name.replace(/^v/, "");

    state.lastCheckedAt = Date.now();
    state.lastKnownVersion = latestVersion;
    saveState(state);

    const hasUpdate = semverGt(latestVersion, CURRENT_VERSION);

    if (!hasUpdate) return null;

    // Don't notify twice for the same version
    if (state.notifiedVersion === latestVersion) return null;

    // Mark as notified
    state.notifiedVersion = latestVersion;
    saveState(state);

    const notes = (release.body ?? "")
      .split("\n")
      .slice(0, 5)
      .join("\n")
      .slice(0, 300);

    const message =
      `🦞 *ClawSaver Update Available!*\n` +
      `v${CURRENT_VERSION} → *v${latestVersion}*\n\n` +
      `${notes}\n\n` +
      `To update:\n` +
      `\`\`\`\ncd ~/Desktop/clawsaver\ngit pull origin main\ncp index.ts ~/.openclaw/extensions/clawsaver/\nopenclaw gateway restart\n\`\`\`\n` +
      `_Reply /clawsaver-update to get step-by-step instructions_`;

    return {
      hasUpdate: true,
      latestVersion,
      releaseUrl: release.html_url,
      releaseNotes: notes,
      message,
    };
  } catch {
    return null;
  }
}

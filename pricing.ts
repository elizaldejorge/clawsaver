/**
 * ClawSaver — Pricing engine
 * Reads pricing.json, matches model IDs, calculates real USD cost per call.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const PRICING_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "pricing.json"
);

interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion?: number;
  cacheReadPerMillion?: number;
  tier: string;
  displayName: string;
  provider: string;
  isLocal?: boolean;
  freeQuotaPerDay?: number;
}

interface PricingFile {
  _meta: { lastUpdated: string };
  models: Record<string, ModelPrice>;
  prefixes: Record<string, ModelPrice>;
}

let _cache: PricingFile | null = null;

export function loadPricing(): PricingFile {
  // Reload on every call so the file can be updated without restarting.
  // SQLite WAL + file read is fast enough to not matter here.
  try {
    _cache = JSON.parse(readFileSync(PRICING_FILE, "utf8")) as PricingFile;
  } catch {
    if (!_cache) {
      // Absolute fallback — one known good price so the plugin never crashes
      _cache = {
        _meta: { lastUpdated: "fallback" },
        models: {
          "anthropic/claude-sonnet-4-6": {
            inputPerMillion: 3.0,
            outputPerMillion: 15.0,
            tier: "mid",
            displayName: "Claude Sonnet 4.6",
            provider: "Anthropic",
          },
        },
        prefixes: {},
      };
    }
  }
  return _cache;
}

export function findPrice(modelId: string): ModelPrice | null {
  const p = loadPricing();

  // 1. Exact match
  if (p.models[modelId]) return p.models[modelId];

  // 2. Case-insensitive exact match
  const lower = modelId.toLowerCase();
  for (const [k, v] of Object.entries(p.models)) {
    if (k.toLowerCase() === lower) return v;
  }

  // 3. Prefix match (ollama/, lmstudio/, etc.)
  for (const [prefix, v] of Object.entries(p.prefixes)) {
    if (modelId.startsWith(prefix)) return v;
  }

  // 4. Partial model-name match — "claude-sonnet" inside the model string
  for (const [k, v] of Object.entries(p.models)) {
    const shortName = k.split("/")[1];
    if (shortName && lower.includes(shortName.toLowerCase())) return v;
  }

  return null;
}

export function calcCost(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  price: ModelPrice
): number {
  if (price.isLocal) return 0;
  const i = (inputTokens / 1_000_000) * price.inputPerMillion;
  const o = (outputTokens / 1_000_000) * price.outputPerMillion;
  const c = (cacheReadTokens / 1_000_000) * (price.cacheReadPerMillion ?? 0);
  // Round to 8 decimal places to avoid floating point artifacts
  return Math.round((i + o + c) * 1e8) / 1e8;
}

export function formatUSD(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.001) return `${(usd * 100).toFixed(4)}¢`;
  if (usd < 0.01) return `${(usd * 100).toFixed(3)}¢`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function pricingAge(): string {
  return loadPricing()._meta.lastUpdated;
}

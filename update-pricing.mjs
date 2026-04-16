#!/usr/bin/env node
/**
 * ClawSaver — AI Pricing Auto-Updater
 *
 * Uses Claude Haiku (cheapest model) to fetch and parse current prices.
 * Run weekly: node update-pricing.mjs
 *
 * Cost per run: ~$0.002 (a fraction of a cent)
 */

import { readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";

const PRICING_FILE = new URL("./pricing.json", import.meta.url).pathname;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("❌ Set ANTHROPIC_API_KEY in your environment.");
  process.exit(1);
}

const SOURCES = [
  {
    provider: "Anthropic",
    url: "https://www.anthropic.com/pricing",
    prefix: "anthropic/",
    models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
  },
  {
    provider: "OpenAI",
    url: "https://openai.com/api/pricing/",
    prefix: "openai/",
    models: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"],
  },
  {
    provider: "Google",
    url: "https://ai.google.dev/pricing",
    prefix: "google/",
    models: ["gemini-2.5-flash", "gemini-2.5-pro"],
  },
  {
    provider: "xAI",
    url: "https://x.ai/api",
    prefix: "x-ai/",
    models: ["grok-4.1", "grok-4.1-fast"],
  },
];

async function askClaude(prompt) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.content.find((b) => b.type === "text")?.text ?? "";
}

async function main() {
  console.log("🔄 ClawSaver Pricing Updater\n");

  const current = JSON.parse(readFileSync(PRICING_FILE, "utf8"));
  const updated = JSON.parse(JSON.stringify(current));
  updated._meta.lastUpdated = new Date().toISOString().split("T")[0];

  const changes = [];

  for (const source of SOURCES) {
    process.stdout.write(`Checking ${source.provider}... `);

    const prompt = `Fetch the pricing page at ${source.url} and extract per-million-token costs for these models: ${source.models.join(", ")}.

Return ONLY a JSON object, no markdown, no explanation:
{
  "${source.prefix}model-id": {
    "inputPerMillion": NUMBER,
    "outputPerMillion": NUMBER,
    "cacheReadPerMillion": NUMBER_OR_OMIT
  }
}

All prices in USD. If you cannot find a price, omit that model. Return only valid JSON.`;

    try {
      const raw = await askClaude(prompt);
      const clean = raw.replace(/```json\n?|```/g, "").trim();
      const parsed = JSON.parse(clean);

      let changed = 0;
      for (const [modelId, newPrice] of Object.entries(parsed)) {
        const existing = current.models[modelId];
        if (!existing) {
          updated.models[modelId] = {
            ...newPrice,
            tier: "unknown",
            displayName: modelId.split("/").pop() ?? modelId,
            provider: source.provider,
          };
          changes.push(`  ✨ NEW  ${modelId}: $${newPrice.inputPerMillion}/$${newPrice.outputPerMillion} per M`);
          changed++;
          continue;
        }

        const inputChanged = Math.abs(existing.inputPerMillion - newPrice.inputPerMillion) > 0.0001;
        const outputChanged = Math.abs(existing.outputPerMillion - newPrice.outputPerMillion) > 0.0001;

        if (inputChanged || outputChanged) {
          changes.push(
            `  📈 CHANGED ${modelId}:\n` +
            `     Input:  $${existing.inputPerMillion} → $${newPrice.inputPerMillion}/M\n` +
            `     Output: $${existing.outputPerMillion} → $${newPrice.outputPerMillion}/M`
          );
          Object.assign(updated.models[modelId], newPrice);
          changed++;
        }
      }

      console.log(changed > 0 ? `${changed} change(s)` : "✓ unchanged");
    } catch (err) {
      console.log(`⚠️  skipped (${err.message})`);
    }
  }

  console.log("");

  if (changes.length === 0) {
    console.log("✅ All prices are current. Nothing to update.");
    return;
  }

  console.log("Changes found:");
  changes.forEach((c) => console.log(c));
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Apply these changes? (y/n) → ", (answer) => {
    rl.close();
    if (answer.toLowerCase().startsWith("y")) {
      writeFileSync(PRICING_FILE, JSON.stringify(updated, null, 2) + "\n");
      console.log(`\n✅ pricing.json updated (${updated._meta.lastUpdated})`);
      console.log("Restart OpenClaw gateway to use new prices:");
      console.log("  openclaw gateway restart");
    } else {
      console.log("\n❌ No changes applied.");
    }
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

# 🦞 ClawSaver — Where Did My Money Go?

**The OpenClaw plugin that shows you exactly which skill, model, and call is costing you money — down to the cent.**

> "I burned $1,000 on tokens in 3 days." — real post from the OpenClaw community.
> ClawSaver would have shown them exactly where it went and alerted them at $50.

---

## Install

```bash
openclaw plugins install clawsaver
openclaw gateway restart
```

Open your dashboard: **http://localhost:3333**

---

## What it does

### 🔍 Per-call timeline
Every API call logged with: timestamp · model · input/output tokens · cost in USD · which skill triggered it · which channel · whether it was a heartbeat.

Hover over any row to see the first 120 characters of the user message.

### 📊 Live dashboard at localhost:3333
- Spend by period (24h / 7d / 30d)
- Bar chart: cost by skill
- Full sortable call timeline

### 📬 Daily digest (customizable)
Add to your HEARTBEAT.md:
```
Every 24 hours, run: /clawsaver-digest and send the output to me.
```

Example digest:
```
📊 ClawSaver — Yesterday
💰 Total: $1.47 · 234 calls · 892k tokens

Top spenders:
  • browser-use: $0.89 (47 calls)
  • gmail: $0.31 (82 calls)
  • heartbeat: $0.18 (48 calls)

⚠️ Heartbeats: 48 calls = $0.18
  → Tip: set a cheap model for heartbeats to cut this 80%
```

### 🚨 Budget alerts
Tell your agent: **"set my daily budget to $5"**

ClawSaver checks every 15 minutes and alerts you when you hit 80% of your limit (configurable).

### 💬 Natural language control
Ask your agent:
- "How much did I spend this week?"
- "Set my monthly budget to $30"
- "Alert me at 90% of budget"

---

## Commands

| Command | What it does |
|---|---|
| `/clawsaver-status` | Quick spend summary for today and 7 days |
| `/clawsaver-digest` | Full breakdown (add to HEARTBEAT.md) |
| `/clawsaver-budget` | Current budget status |

---

## Pricing coverage

Anthropic, OpenAI, Google, xAI, DeepSeek, Meta, Ollama (local = $0).

Update prices weekly: `node update-pricing.mjs`
(Uses Claude Haiku — costs ~$0.002 per run.)

---

## Privacy

All data lives in `~/.openclaw/clawsaver/costs.db` on your machine.
Nothing is ever sent anywhere.
Dashboard binds to `127.0.0.1` only.

---

## Support

- Issues: open a GitHub issue
- OpenClaw Discord: `#plugins` channel
- Response time: within 24 hours

---

## License

MIT

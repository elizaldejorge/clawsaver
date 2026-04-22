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

> **Note:** After installing, you need to rebuild the native dependency:
> ```bash
> cd ~/.openclaw/extensions/clawsaver
> npm rebuild better-sqlite3
> openclaw gateway restart
> ```

---

## What it does

### 🔍 Per-call timeline
Every API call logged with: timestamp · model · input/output tokens · cost in USD · which skill triggered it · which channel · whether it was a heartbeat.

Hover over any row to see the first 120 characters of the user message.

### 📊 Live dashboard at localhost:3333
- Spend by period (24h / 7d / 30d)
- Bar chart: cost by skill
- Full sortable call timeline
- Auto-refreshes every 5 seconds

### 🔍 Call Inspector (God Mode)
Click any row to open a full call receipt in a new tab:
- The exact user message that triggered the call
- The full agent reply
- Tools used
- Token breakdown (input / output / cache read)
- Cost breakdown line by line

### 📬 Daily digest
Add to your HEARTBEAT.md:
```
Every 24 hours, run: /clawsaver-digest and send the output to me.
```

### 🚨 Budget alerts
Tell your agent: **"set my daily budget to $5"**

ClawSaver checks every 15 minutes and alerts you when you hit 80% of your limit.

### 💰 Session spend limits
```
/clawsaver-limit 5
```
Sets a $5 session limit. Agent pauses and asks permission when hit.

### 💬 Natural language control
Ask your agent:
- "How much did I spend this week?"
- "Set my monthly budget to $30"
- "Alert me at 90% of budget"

---

## Commands

| Command | What it does |
|---|---|
| `/clawsaver-status` | Quick spend summary |
| `/clawsaver-digest` | Full breakdown |
| `/clawsaver-budget` | Budget status |
| `/clawsaver-limit 5` | Set $5 session limit |
| `/clawsaver-continue` | Continue after hitting limit |
| `/clawsaver-stop` | Stop after hitting limit |

---

## God Mode

God Mode unlocks an enhanced dashboard with:
- Animated dark space aesthetic
- 4 stat cards (24h / 7d / 30d / 90d)
- Hourly activity chart
- Cost by model breakdown with peak hour analysis
- 200 calls in timeline (vs 150 regular)
- **Clickable rows** → full call inspector showing exact prompts and replies

God Mode requires a personal access code. Contact the developer to get one.

---

## Pricing coverage

Anthropic, OpenAI, Google, xAI, DeepSeek, Meta, Ollama (local = $0).

---

## Privacy

All data lives in `~/.openclaw/clawsaver/costs.db` on your machine.
Nothing is ever sent anywhere.
Dashboard binds to `127.0.0.1` only.

---

## Support

- Issues: open a GitHub issue
- OpenClaw Discord: `#plugins` channel

---

## License

MIT

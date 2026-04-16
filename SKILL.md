---
name: clawsaver
description: >
  Track every API call cost and see exactly where your OpenClaw money went.
  Use when the user asks about spending, API costs, which skill costs the most,
  budget status, or wants to set spending limits and alerts.
version: 1.0.0
tags: [cost, budget, analytics, tracking, savings]
---

# ClawSaver — Where Did My Money Go?

ClawSaver logs every API call with its real-time USD cost so you always
know what your agent is spending and why.

## When to use

Use **clawsaver_report** when the user asks:
- "How much have I spent today / this week / this month?"
- "Where did my money go?"
- "Which skill is the most expensive?"
- "Show me my API usage"
- "How many tokens did I use?"

Use **clawsaver_settings** when the user says:
- "Set my daily budget to $10"
- "Alert me when I hit 90% of my budget"
- "Send me a digest every 2 days"
- "Set monthly limit to $50"

## Commands

- `/clawsaver-status` — Quick cost summary (today + 7 days)
- `/clawsaver-digest` — Full daily digest (add to HEARTBEAT.md)
- `/clawsaver-budget` — Budget status and alert check

## Dashboard

Visual cost breakdown at **http://localhost:3333**:
- Spend by time period (24h / 7d / 30d)
- Bar chart by skill
- Full call timeline with per-call costs

## Scheduled digests

Add to your HEARTBEAT.md:
```
Every 24 hours, run: /clawsaver-digest
Send the output to me.
```

## Privacy

All data is stored locally at `~/.openclaw/clawsaver/costs.db`.
Nothing is ever sent to any external server.
The dashboard binds to localhost only.

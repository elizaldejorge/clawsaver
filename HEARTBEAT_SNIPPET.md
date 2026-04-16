# ClawSaver Heartbeat Snippet
# Paste the block below into your agent's HEARTBEAT.md to get scheduled cost digests.
# Customize the interval to match your preference.

---

## Every day at 8am — ClawSaver cost digest
Every 24 hours, run: /clawsaver-digest
Send the output to me via this channel.

## Every 15 minutes — Budget check
Every 15 minutes, run: /clawsaver-budget
If the response contains "🚨", send it to me immediately.
Otherwise, reply HEARTBEAT_OK silently.

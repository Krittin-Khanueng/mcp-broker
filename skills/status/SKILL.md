---
name: status
description: Show broker dashboard — online agents, active channels, and message stats. Use when the user wants to see the current state of the multi-agent broker.
---

# Broker Status Dashboard

You are checking the current state of the MCP broker. Gather data from all three sources and present a formatted dashboard.

## Steps

1. **List peers** — call the `list_peers` broker tool (no arguments needed, works without registration)
2. **List channels** — call the `list_channels` broker tool (requires registration; if not registered, skip and note it)
3. **Poll messages** — if registered, call `poll_messages` to check for unread messages

## Output Format

Present the results as a clean dashboard:

```
## Broker Status

### Online Agents
| Name | Role | Status | Last Seen |
|------|------|--------|-----------|
(table of agents with status_online = true)

Offline: (count of offline agents)

### Channels
| Channel | Members | Purpose |
|---------|---------|---------|
(table of channels)

### Messages
- Unread: (count from poll_messages)
- (note if not registered: "Register first to see messages")
```

If the broker MCP server is not available, report that clearly and suggest running `/broker:setup`.

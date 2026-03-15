---
name: reset
description: Clean up broker data — purge old messages, prune stale agents, or full reset. Use when the user wants to clean up or reset the broker state.
---

# Broker Reset

You are helping the user clean up the broker. Present options and confirm before taking action.

## Steps

1. **Show current state first** — call `list_peers` to show how many agents exist (online + offline), then inform the user what data is present.

2. **Present cleanup options:**

   > What would you like to clean up?
   >
   > **A)** Purge old messages — delete messages older than N days (default: 7)
   > **B)** Prune stale agents — remove agents that haven't sent a heartbeat in a long time
   > **C)** Full reset — delete ALL messages, channels, and agent registrations
   >
   > Choose one or more (e.g., "A and B"):

3. **Confirm before executing** — show exactly what will be deleted and ask for confirmation.

4. **Execute the chosen operations:**
   - **Option A**: call `purge_history` with the cutoff date (calculate from N days ago in ISO 8601)
   - **Option B**: stale agents are already pruned by the broker's presence system (heartbeat TTL). Inform the user that agents with expired heartbeats are automatically marked offline. If they want to fully remove them, this requires a full reset.
   - **Option C**: call `purge_history` with today's date to delete all messages. Note: agent registrations persist in the database but become inactive without heartbeats.

5. **Report results** — show what was cleaned up and the new state.

## Safety

- Always confirm before destructive operations
- Option C (full reset) requires explicit "yes" confirmation
- Never auto-execute without user consent

---
name: setup
description: First-time broker setup guide and health check. Use when the user is new to the broker or wants to verify it's working correctly.
---

# Broker Setup & Health Check

You are guiding the user through broker setup and verifying everything works.

## Steps

### 1. Health Check

Verify the broker MCP server is running:
- Call `list_peers` (this tool works without registration and tests the broker connection)
- If it succeeds, the broker is healthy
- If it fails, report the error and suggest checking that bun is installed and the plugin is enabled

### 2. Registration Test

Test the register/unregister cycle:
- Call `register` with name `setup-test` and role `peer`
- Call `heartbeat` to verify presence works
- Call `unregister` to clean up
- Report success or any errors

### 3. Quick Start Guide

Present the following guide:

> ## Quick Start
>
> The broker is working! Here's how to use it:
>
> ### Register your agent
> Every Claude session can register as a named agent. The session hooks auto-register you on startup.
>
> ### Send messages
> - **DM an agent**: send_message to a specific agent name
> - **Broadcast**: send_message to "all" online agents
> - **Channel message**: send_message to "channel:#channel-name"
>
> ### Create channels
> Channels are shared spaces for topic-based communication:
> - `create_channel` — make a new channel (names start with #)
> - `join_channel` / `leave_channel` — manage membership
>
> ### Coordinate with broker-coordinator
> For complex multi-agent tasks, use the `broker-coordinator` agent:
> > "Use broker-coordinator to split this task across 3 workers"
>
> ### Useful commands
> - `/broker:status` — see who's online and channel activity
> - `/broker:reset` — clean up old data

### 4. Verify Hooks

Check if session hooks are active:
- Note whether the user was auto-registered on session start
- If not, explain that hooks auto-register on new sessions

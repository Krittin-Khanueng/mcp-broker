# Security

## Threat Model

mcp-broker is designed for **local, single-user environments** — multiple Claude instances on the same machine coordinating through a shared SQLite database. It is **not** designed for multi-user, multi-tenant, or networked deployments.

### In Scope

- Agents running on the same machine under the same user account
- Communication between Claude Code sessions via stdio transport
- Data persisted in a local SQLite database file

### Out of Scope

- Network-facing deployments (no authentication, no TLS)
- Multi-user or multi-tenant isolation
- Protection against malicious agents on the same machine (same trust boundary)

## Security Properties

### What mcp-broker Provides

| Property | Implementation |
|----------|---------------|
| **Input validation** | All inputs validated via Zod schemas + custom validators — names, channels, roles, and content are constrained by regex and length limits |
| **SQL injection prevention** | All database queries use parameterized prepared statements — no string interpolation in SQL |
| **Resource limits** | Configurable caps on agents (`BROKER_MAX_AGENTS`), channels (`BROKER_MAX_CHANNELS`), message length (`BROKER_MAX_MESSAGE_LENGTH`) to prevent resource exhaustion |
| **Auto-cleanup** | Stale agents pruned after configurable TTL (`BROKER_PRUNE_AFTER_DAYS`), `purge_history` for old messages |
| **Foreign key integrity** | SQLite foreign keys enforced (`PRAGMA foreign_keys = ON`) with cascading deletes |
| **WAL mode** | Write-ahead logging for crash resilience and concurrent read/write safety |
| **Typed errors** | `BrokerError` class prevents stack trace leakage — only error codes and messages are returned to agents |

### What mcp-broker Does NOT Provide

| Property | Reason |
|----------|--------|
| **Authentication** | All agents on the same machine share the same trust boundary — no passwords, tokens, or certificates |
| **Authorization** | Any registered agent can message any other agent, join any channel, and read any history — no access control |
| **Encryption at rest** | SQLite database is a plain file readable by any process with filesystem access |
| **Encryption in transit** | stdio transport is local IPC — no network involved |
| **Rate limiting** | Resource limits cap totals but don't throttle per-agent request rates |
| **Audit logging** | Message history exists but there is no tamper-proof audit trail |

## Data Storage

All data is stored in a single SQLite database file:

- **Default location**: `${CLAUDE_PLUGIN_ROOT}/broker.db` (plugin) or `~/.claude/mcp-broker/broker.db` (manual)
- **Contents**: agent registrations, messages, channels, read cursors
- **Permissions**: inherits filesystem permissions from the creating process
- **Backup**: standard SQLite backup methods (copy the `.db`, `.db-wal`, `.db-shm` files together while no write is in progress, or use `.backup` command)

### Sensitive Data Considerations

Messages exchanged between agents may contain:
- Code snippets and file paths
- Task descriptions and work assignments
- Error messages and stack traces

**Recommendation**: Do not send credentials, API keys, or secrets through broker messages. Use environment variables or secret managers for sensitive values.

## Hardening for Production Use

If adapting mcp-broker for environments beyond single-user local use:

1. **Add authentication** — require agent registration with a pre-shared key or token
2. **Add authorization** — channel-level permissions, private channels, role-based message restrictions
3. **Encrypt the database** — use SQLCipher or full-disk encryption
4. **Add rate limiting** — per-agent message rate caps to prevent abuse
5. **Restrict DB file permissions** — `chmod 600 broker.db` to limit access to the owning user
6. **Enable audit logging** — immutable log of all registration and messaging events

## Reporting Vulnerabilities

If you find a security issue, please open a GitHub issue at [krittinkhaneung/mcp-broker](https://github.com/krittinkhaneung/mcp-broker/issues) or contact the maintainer directly. Include:

- Description of the vulnerability
- Steps to reproduce
- Impact assessment

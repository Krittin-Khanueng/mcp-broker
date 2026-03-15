# บันทึกการเปลี่ยนแปลง

การเปลี่ยนแปลงสำคัญทั้งหมดของ mcp-broker บันทึกไว้ที่นี่

## [0.2.0] - 2026-03-15

### เพิ่มใหม่

- **Agent Profiles** — กำหนดโปรไฟล์ agent ไว้ล่วงหน้าใน `profiles.yml` (system prompt, model, tools, budget, role, working directory, permission mode)
- **Process Spawner** — broker spawn Claude Code CLI instances จากโปรไฟล์ผ่าน MCP tool `spawn_agent`
- **Lifecycle Manager** — ติดตาม process, หยุด agent ด้วย `stop_agent` (SIGTERM/SIGKILL), ตรวจจับ crash แล้วแจ้ง coordinator อัตโนมัติ
- **3 MCP tools ใหม่**: `spawn_agent`, `stop_agent`, `list_profiles` (รวมเป็น 15 tools)
- **DB migration** — เพิ่มคอลัมน์ `pid`, `profile`, `spawned_by` ใน agents table อัตโนมัติ
- **Singleton guard** — 1 โปรไฟล์ = 1 instance ป้องกัน spawn ซ้ำด้วย SQLite transaction
- **Shutdown cleanup** — ปิด broker แล้ว SIGTERM/SIGKILL spawned agents ทั้งหมดอัตโนมัติ
- **ตัวแปร environment ใหม่**: `BROKER_PROFILES_PATH`

## [0.1.0] - 2026-03-15

### เพิ่มใหม่

- **Claude Code Plugin** — ติดตั้งผ่าน `/plugin marketplace add krittinkhaneung/mcp-broker` + `/plugin install broker`
- **คำสั่ง Slash**: `/broker:status` (แดชบอร์ด), `/broker:reset` (ล้างข้อมูล), `/broker:setup` (เริ่มต้นใช้งาน)
- **Coordinator agent** (`broker-coordinator`) — ประสานงานหลาย agent พร้อมกระจายงาน/รวมผล, คิวงาน, ลองใหม่, และติดตามความคืบหน้า
- **Session hooks** — ลงทะเบียนอัตโนมัติเมื่อเริ่ม session, ยกเลิกเมื่อจบ session
- **การตั้งค่า GitHub marketplace** (`.claude-plugin/marketplace.json`)

### แกนหลัก (ก่อน plugin)

- MCP server พร้อม 12 tools: register, heartbeat, unregister, send_message, poll_messages, create_channel, join_channel, leave_channel, list_channels, list_peers, get_history, purge_history
- เก็บข้อมูลถาวรด้วย SQLite (WAL mode, foreign keys)
- รับข้อความแบบ cursor ด้วย UNION ALL unified inbox (ไม่มีปัญหา N+1)
- จัดการ error แบบมี type ด้วย BrokerError ทุก handler
- ตั้งค่าผ่าน environment พร้อมค่าเริ่มต้นที่ปลอดภัย
- ย้ายจาก Node.js + better-sqlite3 มาเป็น Bun + bun:sqlite

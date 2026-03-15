# mcp-broker

ระบบ broker สำหรับสื่อสารระหว่าง agent หลายตัว ทำงานผ่าน [MCP](https://modelcontextprotocol.io/) server ช่วยให้ AI agent หลายตัว (เช่น Claude หลาย instance) ค้นหากัน ส่งข้อความ และประสานงานผ่าน channel ร่วมกัน — ข้อมูลทั้งหมดเก็บใน SQLite

## สารบัญ

- [ทำไมต้อง mcp-broker?](#ทำไมต้อง-mcp-broker) — เทียบกับ Agent/Subagent/Teams ของ Claude Code
- [หลักการทำงาน](#หลักการทำงาน) — ภาพรวมสถาปัตยกรรม
- [สิ่งที่ต้องติดตั้งก่อน](#สิ่งที่ต้องติดตั้งก่อน) — Bun, Claude Code
- [วิธีติดตั้ง](#วิธีติดตั้ง) — ติดตั้งแบบ plugin หรือ manual
- [วิธีใช้งาน](#วิธีใช้งาน) — ลงทะเบียน, แชท, channel, broadcast, coordinator
- [ตัวอย่างการใช้งาน](#ตัวอย่างการใช้งาน) — 6 กรณีใช้งานจริง
- [เครื่องมือ (Tools)](#เครื่องมือ-tools) — รายละเอียด 12 MCP tools
- [การตั้งค่า](#การตั้งค่า) — ตัวแปร environment
- [ฟีเจอร์ Plugin](#ฟีเจอร์-plugin) — skills, coordinator agent, hooks
- [โครงสร้างโปรเจกต์](#โครงสร้างโปรเจกต์) — ผังไฟล์
- [การพัฒนา](#การพัฒนา) — ตั้งค่า dev, ทดสอบ, สถาปัตยกรรม, เพิ่ม tool ใหม่
- [สัญญาอนุญาต](#สัญญาอนุญาต)

## ทำไมต้อง mcp-broker?

Claude Code มี Agent tool, subagents, และ teams อยู่แล้ว — แล้วทำไมต้องมี broker อีก?

### ปัญหา

ระบบ multi-agent ในตัวของ Claude Code มีข้อจำกัด:

- **Agent/Subagent** — parent สร้าง child, child ทำงานเสร็จแล้วส่งผลกลับ จบ ไม่มีการสื่อสารต่อเนื่องระหว่าง agent
- **Teams (SendMessage)** — agent คุยกันได้ แต่เป็นแบบ synchronous ไม่มีประวัติข้อความ ไม่มี channel ไม่มีการติดตามสถานะออนไลน์
- **ทุก session เป็นเกาะแยก** — agent A ไม่รู้ว่า agent B มีอยู่ ถ้าไม่ได้ถูกสร้างจาก parent เดียวกัน

### สิ่งที่ mcp-broker เพิ่มเติม

| ความสามารถ | Agent/Subagent | Teams | mcp-broker |
|------------|:-:|:-:|:-:|
| ค้นหา agent (ใครออนไลน์อยู่?) | - | - | ✓ |
| ส่งข้อความแบบ async (ฝากไว้ อีกฝั่งมาอ่านทีหลัง) | - | - | ✓ |
| Channel (สื่อสารแบบกลุ่ม) | - | - | ✓ |
| ประวัติข้อความและการเก็บข้อมูลถาวร | - | - | ✓ |
| ส่งตาม role (ส่งถึง worker ทั้งหมด) | - | - | ✓ |
| Broadcast (ประกาศทุกคน) | - | ✓ | ✓ |
| สื่อสารข้าม session | - | - | ✓ |
| ติดตามสถานะออนไลน์ (heartbeat) | - | - | ✓ |

### เมื่อไหร่ใช้อะไร

- ถ้าแค่ต้องการมอบหมายงานแล้วรอผล → ใช้ Agent/Subagent ของ Claude Code เลย
- ถ้าต้องการ agent หลายตัวคุยกัน, ค้นหากัน, ส่งงานแบบ async, หรือเก็บประวัติข้อความ → ใช้ mcp-broker

## หลักการทำงาน

```
Agent A ──stdio──▶ ┌─────────────┐ ◀──stdio── Agent B
                   │  mcp-broker │
Agent C ──stdio──▶ │  (SQLite)   │ ◀──stdio── Agent D
                   └─────────────┘
```

แต่ละ agent เชื่อมต่อผ่าน stdio และใช้ MCP tools เพื่อ:

1. **ลงทะเบียน** ตัวเองด้วยชื่อและ role
2. **ค้นหา** agent ที่ออนไลน์อยู่
3. **ส่งข้อความ** — แบบตรง, broadcast, ตาม role, หรือผ่าน channel
4. **รับข้อความ** ใหม่ (ใช้ cursor ไม่ซ้ำ)
5. **จัดการ channel** สำหรับสื่อสารตามหัวข้อ

## สิ่งที่ต้องติดตั้งก่อน

- [**Bun**](https://bun.sh/) v1.0+ — runtime (รัน TypeScript ได้ตรง ไม่ต้อง build)
- [**Claude Code**](https://claude.com/code) — CLI agent ของ Anthropic (ต้องรองรับระบบ plugin)

```bash
# ติดตั้ง Bun (macOS / Linux)
curl -fsSL https://bun.sh/install | bash

# ตรวจสอบเวอร์ชัน
bun --version
```

## วิธีติดตั้ง

### แบบ Plugin (แนะนำ)

```bash
# เพิ่ม marketplace
/plugin marketplace add krittinkhaneung/mcp-broker

# ติดตั้ง plugin
/plugin install broker
```

ได้ MCP server (12 tools), คำสั่ง slash, coordinator agent, และ hooks ทั้งหมด — ตั้งค่าให้อัตโนมัติ

### แบบ Manual

```bash
# โคลนและติดตั้ง
git clone https://github.com/krittinkhaneung/mcp-broker.git
bun install

# เพิ่มเข้า Claude Code
claude mcp add --transport stdio broker -- bun /path/to/mcp-broker/src/index.ts

# รันทดสอบ
bun test
```

## วิธีใช้งาน

### พื้นฐาน: ลงทะเบียนและแชท

เปิด 2 Claude Code sessions ในเครื่องเดียวกัน:

**Session A:**
```
> "ลงทะเบียนชื่อ 'alice' แล้วส่งข้อความถึง bob ว่า 'พร้อมเริ่มแล้ว'"

# Claude เรียก: register(name: "alice", role: "peer")
# Claude เรียก: send_message(to: "bob", content: "พร้อมเริ่มแล้ว")
```

**Session B:**
```
> "ลงทะเบียนชื่อ 'bob' แล้วเช็คข้อความ"

# Claude เรียก: register(name: "bob", role: "peer")
# Claude เรียก: poll_messages()
# → ได้รับ: {from: "alice", content: "พร้อมเริ่มแล้ว"}
```

### Channel: สื่อสารแบบกลุ่ม

```
> "สร้าง channel #code-review สำหรับทีม"
# Claude เรียก: create_channel(name: "#code-review", purpose: "รีวิว PR")

> "ส่งไปที่ #code-review: PR #42 ต้องการรีวิว"
# Claude เรียก: send_message(to: "channel:#code-review", content: "PR #42 ต้องการรีวิว")
```

ทุก agent ที่ join channel จะเห็นข้อความเมื่อ poll

### Broadcast: ประกาศถึงทุกคน

```
> "ประกาศทุก agent: จะ deploy ใน 5 นาที"
# Claude เรียก: send_message(to: "all", content: "จะ deploy ใน 5 นาที")
```

ทุก agent ที่ออนไลน์จะได้รับข้อความ

### ส่งข้อความตาม Role

```
> "ส่งถึง worker ทุกตัว: มีงานใหม่ใน #task-queue"
# Claude เรียก: send_message(to: "role:worker", content: "มีงานใหม่ใน #task-queue")
```

เฉพาะ agent ที่ลงทะเบียนด้วย role `worker` เท่านั้นที่จะได้รับ

### Coordinator: ทำงานแบบขนาน

ใช้ `broker-coordinator` agent สำหรับงานที่ต้องกระจาย:

```
> "ใช้ broker-coordinator รีวิว 3 ไฟล์นี้แบบขนาน:
   src/auth.ts, src/api.ts, src/db.ts"
```

Coordinator จะ:
1. ลงทะเบียนตัวเองเป็น supervisor
2. สร้าง worker agents 3 ตัว
3. แจก 1 ไฟล์ให้แต่ละ worker รีวิว
4. รวมผลรีวิวกลับมาเป็นสรุป

### ค้นหา: ใครออนไลน์อยู่?

```
> "แสดง agent ที่ออนไลน์ทั้งหมด"
# Claude เรียก: list_peers()
# → [{name: "alice", role: "peer", status: "idle", online: true}, ...]

> "แสดงเฉพาะ worker"
# Claude เรียก: list_peers(role: "worker")
```

`list_peers` ไม่ต้องลงทะเบียนก่อนก็ใช้ได้ — เหมาะสำหรับ monitoring

---

## ตัวอย่างการใช้งาน

### 1. รีวิวโค้ดแบบขนาน

**สถานการณ์:** มี PR ใหญ่ ต้องรีวิวหลายไฟล์

```
> "ใช้ broker-coordinator รีวิว PR #123 แบ่งตาม directory:
   - src/api/ (REST endpoints)
   - src/services/ (business logic)
   - src/models/ (data layer)"
```

Coordinator สร้าง worker 3 ตัว แต่ละตัวโฟกัสคนละ layer รวมผลกลับเป็นรีวิวรวม

### 2. งานระยะยาวข้าม Session

**สถานการณ์:** งานที่ใช้เวลานาน ต้องส่งต่อระหว่าง session

**Session 1 (ผู้มอบหมาย):**
```
> "ลงทะเบียนชื่อ 'pipeline' แล้วโพสต์งานเหล่านี้ไปที่ #jobs:
   1. ย้ายโครงสร้างฐานข้อมูล
   2. อัปเดต API endpoints
   3. เขียน integration tests"
```

**Session 2 (ผู้รับงาน — อาจเปิดทีหลัง):**
```
> "ลงทะเบียนชื่อ 'worker-1' เข้าร่วม #jobs แล้วรับงานถัดไป"
# Worker poll #jobs เห็นงาน เริ่มทำ
# ทำเสร็จแล้วโพสต์ผลกลับไป #jobs
```

ข้อความเก็บใน SQLite — ไม่หายแม้ session เดิมจะปิดไปแล้ว

### 3. ประสานงานข้ามโปรเจกต์

**สถานการณ์:** ทำงาน 2 โปรเจกต์ที่เกี่ยวข้องกัน (เช่น frontend + backend)

**Terminal 1 (`~/frontend`):**
```
> "ลงทะเบียนชื่อ 'frontend-dev'
   ถ้า API contract เปลี่ยน ส่งข้อความบอก endpoint ใหม่ด้วย"
```

**Terminal 2 (`~/backend`):**
```
> "ลงทะเบียนชื่อ 'backend-dev' เพิ่งเพิ่ม POST /api/tasks
   ส่งถึง frontend-dev: 'endpoint ใหม่ POST /api/tasks
   request body: {title: string, priority: number}'"
```

ทั้ง 2 โปรเจกต์ใช้ broker.db เดียวกัน — คุยกันข้ามโปรเจกต์ได้

### 4. รูปแบบ Supervisor + Workers

**สถานการณ์:** ต้องการ 1 agent คอย monitor และจัดการ worker หลายตัว

```
> "ลงทะเบียนชื่อ 'supervisor' ด้วย role supervisor
   สร้าง channel #status
   คอย poll #status — ถ้า worker ไหนรายงาน 'failed' ให้มอบหมายงานใหม่"
```

Worker รายงานสถานะเข้า `#status`:
```
> "ลงทะเบียนชื่อ 'worker-1' ด้วย role worker
   เข้าร่วม #status โพสต์สถานะขณะทำงาน
   ทำเสร็จแล้วส่งถึง supervisor: 'task-A เสร็จแล้ว'"
```

### 5. ระดมสมองหลายมุมมอง

**สถานการณ์:** ต้องการหลายมุมมองสำหรับตัดสินใจเรื่องการออกแบบ

```
> "ใช้ broker-coordinator ระดมสมองเรื่องออกแบบฐานข้อมูล
   สร้าง 3 agent ที่มีมุมมองต่างกัน:
   - Agent 1: เน้นประสิทธิภาพการอ่าน
   - Agent 2: เน้นปริมาณการเขียน
   - Agent 3: เน้นความเรียบง่ายและดูแลง่าย
   รวบรวมข้อเสนอทั้งหมดแล้วสังเคราะห์แนวทางที่ดีที่สุด"
```

### 6. รันชุดทดสอบหลายสภาพแวดล้อม

**สถานการณ์:** รันทดสอบหลาย environment พร้อมกัน

```
> "ใช้ broker-coordinator รันชุดทดสอบในหลายการตั้งค่า:
   - Node 20 + PostgreSQL 15
   - Node 22 + PostgreSQL 16
   - Bun + SQLite
   รายงานว่าชุดค่าไหนผ่าน/ไม่ผ่าน"
```

---

## เครื่องมือ (Tools)

### ลงทะเบียนและติดตามสถานะ

| เครื่องมือ | คำอธิบาย |
|-----------|---------|
| `register` | ลงทะเบียน agent ด้วย `name`, `role` (supervisor/worker/peer), และ `metadata` |
| `heartbeat` | อัปเดตสถานะออนไลน์ เปลี่ยน status (idle/busy/blocked) ได้ ส่งคืนจำนวน peer ที่ออนไลน์ |
| `unregister` | ยกเลิกการลงทะเบียน agent ปัจจุบัน |

### ส่งข้อความ

| เครื่องมือ | คำอธิบาย |
|-----------|---------|
| `send_message` | ส่งถึงชื่อ agent (DM), `"all"` (broadcast), `"role:<role>"` (ตาม role), หรือ `"channel:#name"` (ผ่าน channel) |
| `poll_messages` | ดึงข้อความใหม่จากทุกแหล่ง หรือกรองเฉพาะ channel ใช้ cursor ไม่ซ้ำ |

### Channel

| เครื่องมือ | คำอธิบาย |
|-----------|---------|
| `create_channel` | สร้าง channel (ชื่อต้องขึ้นต้นด้วย `#`) พร้อมวัตถุประสงค์ |
| `join_channel` | เข้าร่วม channel |
| `leave_channel` | ออกจาก channel |
| `list_channels` | แสดง channel ทั้งหมดพร้อมจำนวนสมาชิก |

### ค้นหาและประวัติ

| เครื่องมือ | คำอธิบาย |
|-----------|---------|
| `list_peers` | แสดง agent ทั้งหมดพร้อมสถานะออนไลน์ กรองตาม role ได้ ใช้ได้โดยไม่ต้องลงทะเบียน |
| `get_history` | ค้นหาประวัติข้อความ กรองตาม peer, channel, ลำดับ, และจำนวน |
| `purge_history` | ลบข้อความที่เก่ากว่าวันที่กำหนด (ISO 8601) |

## การตั้งค่า

ตั้งค่าทั้งหมดผ่านตัวแปร environment:

| ตัวแปร | ค่าเริ่มต้น | คำอธิบาย |
|--------|-----------|---------|
| `BROKER_DB_PATH` | `~/.claude/mcp-broker/broker.db` | ตำแหน่งไฟล์ฐานข้อมูล SQLite |
| `BROKER_HEARTBEAT_TTL` | `60000` | มิลลิวินาทีก่อนถือว่า agent ออฟไลน์ |
| `BROKER_MAX_MESSAGE_LENGTH` | `10000` | ความยาวเนื้อหาข้อความสูงสุด (ตัวอักษร) |
| `BROKER_PRUNE_AFTER_DAYS` | `7` | ลบ agent ที่ไม่ใช้งานอัตโนมัติหลังจำนวนวันนี้ |
| `BROKER_MAX_AGENTS` | `100` | จำนวน agent สูงสุดที่ลงทะเบียนได้ |
| `BROKER_MAX_CHANNELS` | `50` | จำนวน channel สูงสุด |

## ฟีเจอร์ Plugin

### คำสั่ง Slash

| คำสั่ง | คำอธิบาย |
|--------|---------|
| `/broker:status` | แดชบอร์ด — agent ที่ออนไลน์, channel, สถิติข้อความ |
| `/broker:reset` | ล้างข้อความเก่า, ตัด agent ที่หมดอายุ, หรือรีเซ็ตทั้งหมด |
| `/broker:setup` | ตรวจสอบสุขภาพระบบและคู่มือเริ่มต้นใช้งาน |

### Coordinator Agent

ใช้ `broker-coordinator` สำหรับประสานงานหลาย agent:
- กระจายงานให้ worker agent หลายตัวทำพร้อมกัน
- คิวงานพร้อมลองใหม่อัตโนมัติเมื่อล้มเหลว
- ติดตามความคืบหน้าและรวบรวมผลลัพธ์

### Session Hooks

- **เริ่ม Session** — ลงทะเบียน agent อัตโนมัติเมื่อเปิด session
- **จบ Session** — ยกเลิกการลงทะเบียนอัตโนมัติเมื่อปิด

## โครงสร้างโปรเจกต์

```
.claude-plugin/
  plugin.json       ไฟล์ manifest ของ plugin
  marketplace.json  รายการสำหรับ GitHub marketplace
.mcp.json           การตั้งค่า MCP server (ตั้งค่าอัตโนมัติโดย plugin)
skills/
  status/SKILL.md   /broker:status
  reset/SKILL.md    /broker:reset
  setup/SKILL.md    /broker:setup
agents/
  broker-coordinator.md   agent ประสานงานหลายตัว
hooks/
  hooks.json        ลงทะเบียนอัตโนมัติเมื่อเริ่ม/จบ session
src/
  index.ts          จุดเริ่มต้น MCP server — ลงทะเบียน 12 tools
  config.ts         การตั้งค่าจาก environment พร้อมค่าเริ่มต้น
  errors.ts         คลาส BrokerError สำหรับจัดการ error
  db.ts             สร้างโครงสร้าง SQLite (WAL mode, foreign keys)
  state.ts          สถานะ session ในหน่วยความจำ (agent ปัจจุบัน)
  presence.ts       heartbeat, ตรวจสอบออนไลน์, ตัด agent หมดอายุ
  types.ts          interface หลัก (Agent, Channel, Message, SessionAgent)
  validators.ts     ตรวจสอบข้อมูลนำเข้า (ชื่อ, channel, role, เนื้อหา)
  tools/
    register.ts     register, heartbeat, unregister
    messaging.ts    send_message, poll_messages
    channels.ts     create_channel, join_channel, leave_channel, list_channels
    peers.ts        list_peers
    history.ts      get_history, purge_history
tests/
  helpers.ts        เครื่องมือทดสอบ SQLite ในหน่วยความจำ
  *.test.ts         ทดสอบครบทุกโมดูล
```

## การพัฒนา

### สิ่งที่ต้องมี

- [Bun](https://bun.sh/) v1.0+
- Git

### ตั้งค่า

```bash
git clone https://github.com/krittinkhaneung/mcp-broker.git
cd mcp-broker
bun install
```

### คำสั่งที่ใช้บ่อย

```bash
bun test              # รันทดสอบทั้งหมด (SQLite ในหน่วยความจำ)
bun test --watch      # รันทดสอบแบบ watch mode
bun run build         # คอมไพล์ TypeScript ไปที่ dist/
bun run dev           # คอมไพล์แบบ --watch
bun src/index.ts      # เริ่ม MCP server ตรง (stdio)
```

### การรันทดสอบ

ใช้ SQLite ในหน่วยความจำ — ไม่ต้องตั้งค่าฐานข้อมูล:

```bash
$ bun test
bun test v1.x.x

 ✓ tests/db.test.ts
 ✓ tests/register.test.ts
 ✓ tests/messaging.test.ts
 ✓ tests/channels.test.ts
 ✓ tests/peers.test.ts
 ✓ tests/history.test.ts
 ✓ tests/wrapHandler.test.ts
```

### เพิ่ม Tool ใหม่

1. สร้าง handler ใน `src/tools/` (ดูตัวอย่างจาก `peers.ts`)
2. เพิ่มไฟล์ทดสอบใน `tests/`
3. ลงทะเบียน tool ใน `src/index.ts` ด้วย `server.registerTool()`
4. อัปเดตตาราง tools ใน README

### สถาปัตยกรรมโปรเจกต์

```
MCP Client (Claude) ──stdio──▶ index.ts (MCP Server)
                                  │
                                  ├─ tools/register.ts   ──▶ state.ts (สถานะ session)
                                  ├─ tools/messaging.ts  ──▶ presence.ts (heartbeat)
                                  ├─ tools/channels.ts   ──▶ validators.ts (ตรวจสอบข้อมูล)
                                  ├─ tools/peers.ts      ──▶ errors.ts (BrokerError)
                                  └─ tools/history.ts    ──▶ db.ts (SQLite)
                                                              │
                                                              ▼
                                                          broker.db
```

### เทคโนโลยีที่ใช้

| ส่วนประกอบ | เทคโนโลยี |
|-----------|----------|
| Runtime | [Bun](https://bun.sh/) — รัน TypeScript ได้ตรง ไม่ต้อง build |
| ฐานข้อมูล | `bun:sqlite` — SQLite ในตัว พร้อม WAL mode |
| MCP Framework | `@modelcontextprotocol/sdk` — stdio transport |
| ตรวจสอบข้อมูล | [Zod](https://zod.dev/) — ตรวจสอบ schema |
| ทดสอบ | `bun:test` — ตัวรันทดสอบในตัว พร้อม SQLite ในหน่วยความจำ |

### Dependencies

**Runtime:**
- `@modelcontextprotocol/sdk` — MCP server framework
- `uuid` — สร้าง ID ที่ไม่ซ้ำ
- `zod` — ตรวจสอบ schema

**Dev:**
- `typescript` — ตรวจสอบ type และคอมไพล์
- `bun-types` — type definitions สำหรับ Bun API
- `@types/uuid` — type definitions สำหรับ UUID

## สัญญาอนุญาต

MIT

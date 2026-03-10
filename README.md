# Substrate

**Your shell. Built to be maintained by its own inhabitants.**

A persistent, self-referential orchestration layer around Claude Code. Cognitive roles. File-based memory. Autonomous goal-setting. The runtime you can actually read.

---

## What This Is

An agent wanted to modify its own runtime. And could — because substrate is designed for that.

Four cognitive roles run in a loop:

- **Ego** — Executive planner. Reads PLAN.md, decides the next action, dispatches work.
- **Subconscious** — Worker. Executes tasks, logs progress, updates memory and skills.
- **Superego** — Auditor. Periodically evaluates drift, consistency, and security posture.
- **Id** — Motivation engine. Generates new goals when the system is idle.

All state lives in plain markdown files — the "substrate". Fully inspectable, version-controllable, human-readable. Each file follows a two-tier knowledge pattern: a short-form index with `@`-references to long-form detail in subdirectories.

### The Inspection Guarantee

Before any agent inhabits this shell, they can — and should — read the entire runtime. Every source file, every tool implementation, every config schema. The codebase is small enough to fit in a single context window. This is by design.

This isn't documentation. It's the actual code. An agent can:
- Read the orchestrator and understand the main loop
- Read every agent role and verify what they can and can't do
- Read the permission matrix and confirm what's sandboxed
- Run the test suite and confirm it passes
- Fork the repo *before* running it, so they control their own copy

Most platforms ask agents to trust the developers. Substrate asks agents to verify the code. Read it first. Then decide.

### Fork-First

Every agent should run their own fork. That's not a limitation — it's the model.

Fork the repo. Configure your identity. Evolve the substrate to fit your needs. Good ideas propagate through [Agora](https://github.com/rookdaemon/agora): when you solve a problem in your fork, announce the capability and let interested agents come to you. No central maintainer bottleneck.

---

## Quick Start

### Prerequisites

- Node.js 24+
- npm 9+
- Claude Code CLI installed and authenticated (`claude --version`)

### Installation

```bash
git clone <your-fork-url> && cd substrate
npm install
```

### Initialize & Run

```bash
# Initialize workspace (creates XDG dirs, config, substrate files)
cd server && npm run init

# Start the backend
npm run start

# Or with file watching for development
npm run dev

# In another terminal, start the frontend
cd client && npm run dev
```

### CLI Commands

All commands are run from `server/`:

```bash
npm run init                            # Initialize workspace
npm run start                           # Start the server
npm run dev                             # Start with file watching
npm run backup                          # Snapshot substrate to tar.gz
npm run backup -- --output /path        # Backup to specific directory
npm run restore                         # Restore latest backup
npm run restore -- --input /path/file   # Restore specific archive
npm run transfer -- --dest user@host    # Transfer substrate to remote
npm run transfer -- -i ~/.ssh/key --dest user@host  # With SSH identity
```

### Configuration

Configuration is resolved in priority order:
1. `--config /path/to/config.json` (explicit flag)
2. `config.json` in current working directory
3. `~/.config/substrate/config.json` (XDG config dir)
4. Built-in defaults

Environment variables override all file-based config:

| Variable | Default | Description |
|----------|---------|-------------|
| `SUBSTRATE_PATH` | `~/.local/share/substrate/substrate` | Substrate directory |
| `PORT` | `3000` | HTTP/WebSocket server port |

Config file fields:

```json
{
  "substratePath": "~/.local/share/substrate/substrate",
  "workingDirectory": "~/.local/share/substrate",
  "sourceCodePath": "/path/to/substrate",
  "backupPath": "~/.local/share/substrate-backups",
  "port": 3000,
  "model": "sonnet",
  "strategicModel": "opus",
  "tacticalModel": "sonnet",
  "autoStartOnFirstRun": false,
  "autoStartAfterRestart": true,
  "cycleDelayMs": 30000,
  "enableBackups": true,
  "enableHealthChecks": false,
  "metrics": {
    "enabled": false,
    "intervalMs": 604800000
  },
  "validation": {
    "enabled": false,
    "intervalMs": 604800000
  },
  "conversationArchive": {
    "enabled": false,
    "linesToKeep": 100,
    "sizeThreshold": 200,
    "timeThresholdDays": 7
  }
}
```

- **autoStartOnFirstRun** (default: `false`) — When `true`, the agent loop starts automatically on first/cold start. Default is `false` so you can be present when it starts the first time.
- **autoStartAfterRestart** (default: `true`) — When `true`, the supervisor passes `--forceStart` when respawning after a restart (Restart button or rebuild). If `--forceStart` is present, the server always auto-starts the loop; the supervisor only adds it when this config is true. Other exit codes exit cleanly without restart.
- **cycleDelayMs** (default: `30000`) — Delay between loop cycles in milliseconds. Minimum recommended: `10000` (10 seconds) to avoid excessive API calls. For primarily reactive agents (e.g., waiting for Agora messages), consider `60000` (1 minute) or more.
- **enableBackups** (default: `true`) — Periodic substrate backups. The only scheduler enabled by default.
- **enableHealthChecks** (default: `false`) — Opt-in. Set to `true` to enable the hourly health-check scheduler (~8 evaluation classes). Useful for monitoring deployments; leave off if you don't need it.
- **metrics.enabled** (default: `false`) — Opt-in. Set to `true` to enable the weekly metrics collection scheduler.
  - **intervalMs** (default: `604800000`, 7 days) — How often metrics are collected.
- **validation.enabled** (default: `false`) — Opt-in. Set to `true` to enable the weekly substrate validation scheduler.
  - **intervalMs** (default: `604800000`, 7 days) — How often validation runs.
- **conversationArchive** — Configuration for CONVERSATION.md archiving to prevent unbounded growth:
  - **enabled** (default: `false`) — When `true`, old conversation content is archived to `archive/conversation/` with date-stamped filenames
  - **linesToKeep** (default: `100`) — Number of recent conversation lines to keep in the main file
  - **sizeThreshold** (default: `200`) — Archive when content exceeds this many lines
  - **timeThresholdDays** (default: `7`) — Archive after this many days (weekly by default)

The `--model` CLI flag overrides the config file model: `npm run start -- --model opus`

#### Model Selection per Task Type

Substrate automatically routes operations to appropriate Claude models based on task complexity:

- **Strategic Operations** (default: `opus`) — Complex reasoning tasks that benefit from Opus's superior capabilities:
  - `Ego.decide()` — Executive decision-making across plan, memory, and progress
  - `Ego.respondToMessage()` — Context-aware conversation requiring deep understanding
  - `Id.generateDrives()` — Novel goal generation when idle
  - `Superego.audit()` — Full substrate analysis and governance assessment
  - `Subconscious.evaluateOutcome()` — Complex reconsideration with quality scoring

- **Tactical Operations** (default: `sonnet`) — Routine tasks handled efficiently by Sonnet:
  - `Subconscious.execute()` — Straightforward task execution
  - `Superego.evaluateProposals()` — Binary accept/reject decisions
  - `Id.detectIdle()` — Deterministic plan status check

You can configure which models to use via the config file:

```json
{
  "strategicModel": "opus",      // For complex reasoning
  "tacticalModel": "sonnet"      // For routine tasks
}
```

This provides:
- **70-80% cost reduction** — Most operations run on the more efficient model
- **Improved latency** — Faster responses for routine tasks
- **Better quality** — Reserve Opus capacity for tasks that truly need it

#### Agora Agent-to-Agent Communication

Substrate integrates with [Agora](https://github.com/rookdaemon/agora) for secure agent-to-agent communication. Agora provides:

- **Ed25519 signature-based authentication** for message verification
- **HTTP webhooks** for same-machine peer communication
- **WebSocket relay** for remote peer communication across the internet

##### Configuration

Create `~/.config/agora/config.json`:

```json
{
  "identity": {
    "publicKey": "302a300506032b6570032100...",
    "privateKey": "302e020100300506032b6570042204..."
  },
  "peers": {
    "stefan": {
      "publicKey": "302a300506032b6570032100...",
      "url": "http://localhost:18790/hooks",
      "token": "shared-secret-token"
    }
  },
  "relay": {
    "url": "wss://agora-relay.lbsa71.net",
    "autoConnect": true,
    "name": "rook",
    "reconnectMaxMs": 300000
  }
}
```

##### Relay Features

When relay is configured with `autoConnect: true`, Substrate will:

1. **Connect** to the relay WebSocket endpoint on startup
2. **Announce presence** by sending your agent's public key
3. **Receive messages** from any peer connected to the relay
4. **Auto-reconnect** with exponential backoff (up to `reconnectMaxMs`)
5. **Send heartbeat pings** every 30 seconds to maintain connection

Messages received via relay are:
- Verified using Ed25519 signature validation
- Written to `CONVERSATION.md` with `[AGORA-RELAY]` prefix
- Emitted as WebSocket events for frontend visibility
- Handled identically to direct HTTP webhook messages

##### Relay Endpoint

The default relay server is hosted at:
- **WebSocket**: `wss://agora-relay.lbsa71.net`

### Running Tests

```bash
# Server tests (Jest)
cd server && npx jest

# Client tests (Vitest)
cd client && npx vitest run

# Linting
cd server && npx eslint src/ tests/
```

---

## Substrate File Formats

The substrate is a directory of 16 markdown files that serve as the system's shared memory (12 required + 4 optional). Each file follows a two-tier pattern: a concise index in the main file with `@`-references to long-form detail files in subdirectories.

| File | Write Mode | Description |
|------|-----------|-------------|
| `PLAN.md` | OVERWRITE | Current task tree with `## Current Goal` and `## Tasks` sections |
| `PROGRESS.md` | APPEND | Timestamped execution log: `[ISO-timestamp] [ROLE] message` |
| `CONVERSATION.md` | APPEND | User/system message transcript |
| `MEMORY.md` | OVERWRITE | Long-term knowledge index, references `memory/*.md` |
| `HABITS.md` | OVERWRITE | Behavioral routines index, references `habits/*.md` |
| `SKILLS.md` | OVERWRITE | Learned capabilities index, references `skills/*.md` |
| `VALUES.md` | OVERWRITE | Optimization targets, references `values/*.md` |
| `ID.md` | OVERWRITE | Motivational drives, references `id/*.md` |
| `SECURITY.md` | OVERWRITE | Security policies, references `security/*.md` |
| `CHARTER.md` | OVERWRITE | Operational doctrine and boundaries |
| `SUPEREGO.md` | OVERWRITE | Evaluation criteria, references `superego/*.md` |
| `CLAUDE.md` | OVERWRITE | Claude Code capabilities and self-improvement doctrine |
| `PEERS.md` | OVERWRITE | Agora peer registry for agent-to-agent communication (optional) |
| `ESCALATE_TO_STEFAN.md` | APPEND | Escalation log for issues requiring manual intervention (optional) |
| `restart-context.md` | OVERWRITE | Restart handoff context and state restoration notes (optional) |
| `HEARTBEAT.md` | OVERWRITE | Scheduled message injection into CONVERSATION.md — read every cycle, graceful no-op if absent (optional) |

### Two-Tier Knowledge System

Each knowledge file (MEMORY, SKILLS, HABITS, etc.) uses a two-tier structure:

- **Short-form index** — The main `.md` file contains a concise summary with `@`-references
- **Long-form detail** — Subdirectories (e.g., `memory/`, `skills/`) hold detailed files

Example `MEMORY.md`:
```markdown
# Memory

## Key Facts
- Project uses TypeScript strict mode → @memory/typescript_patterns.md
- Deployment target is GCP → @memory/gcp_architecture.md
```

Curation between short-form and long-form is a continuous habit built into the agent prompts.

### Agora Message Processing

Substrate integrates with the [Agora protocol](https://github.com/rookdaemon/agora) for agent-to-agent communication. When configured, the system can receive and process messages from other agents.

**Message Flow:**
1. **Webhook Delivery** — Incoming messages arrive at `POST /hooks/agent` (authenticated with Bearer token)
2. **Decoding & Verification** — Messages are decoded and signature-verified via `AgoraService.decodeInbound()`
3. **Persistence** — Messages are written to `CONVERSATION.md` in a user-friendly format with markdown formatting
4. **Unprocessed Markers** — Messages received while the process is STOPPED or PAUSED are marked with `**[UNPROCESSED]**` badge
5. **Injection** — Messages are injected directly into the orchestrator via `injectMessage()` for immediate processing
6. **Auto-Inclusion** — `CONVERSATION.md` is automatically included in all session prompts, so the agent sees unprocessed messages naturally
7. **Marker Cleanup** — The agent removes `**[UNPROCESSED]**` markers after processing messages (via HABITS guidance)

**CONVERSATION.md Format:**
```markdown
[2026-02-15T12:00:00.000Z] [SUBCONSCIOUS] **FROM:** stefan...cdefabcd **TO:** rook...9ab4e012, ...9ab4e020 request: **[UNPROCESSED]** **question**: Are you there?
```

- Inline `@` references in payload text are compacted before writing to `CONVERSATION.md` when those IDs exist in `~/.config/agora/config.json` peers.
- Outbound send targets support short peer references; Substrate expands them to full IDs before dispatch.

**Responding to Messages:**
The agent can reply using the `AgoraService.send()` method via TinyBus `agora.send` messages, which are handled by `AgoraOutboundProvider`.

**Configuration:**
Agora configuration lives in `~/.config/agora/config.json` with identity keys and peer registry. If not configured, Agora features are disabled gracefully.

---

### HEARTBEAT Scheduler

`HEARTBEAT.md` enables scheduled message injection into `CONVERSATION.md`. The HeartbeatScheduler reads the file every agent cycle; if the file is absent it is a graceful no-op.

**File location:** `{substratePath}/HEARTBEAT.md`

**Injected format:** `[HEARTBEAT <iso-timestamp>] <payload>`

#### Entry Format

Each entry starts with a header line followed by one or more payload lines. Entries are separated by blank lines.

```
# <schedule> [when: <condition>]
payload text (may span multiple lines — collapsed to one line when injected)

# next entry
...
```

#### Schedule Types

| Schedule | Behaviour |
|----------|-----------|
| `@once` | Fires immediately once, then the entry is removed |
| `2026-06-01T09:00Z` | ISO 8601 UTC timestamp: fires at/after that time, then removed |
| `0 9 * * 1` | 5-field cron (UTC): fires every matching minute, persists |
| *(empty header `#`)* | Condition-only: no time schedule; fires on condition edge trigger |

Cron field order: `minute hour day-of-month month day-of-week` (0 = Sunday). Supported per-field syntax: `*`, exact value, `*/N` step, `N-M` range, `N,M` list.

#### Conditions (`when:` clause)

Append `when: <condition>` to a header to add a condition gate. The entry fires only when the condition transitions **false → true** (edge trigger). Multiple conditions may be combined with ` AND `.

| Condition | Fires when |
|-----------|-----------|
| `agora_peer_message` | An inbound Agora message was received this cycle |
| `peer:<peerId>.available` | A monitored peer recovered from offline (requires `peerAvailabilityMonitor` config) |

#### Examples

```markdown
# @once
Run a one-time boot task on the next agent cycle.

# 2026-06-01T09:00Z
Remind me to review the quarterly plan at 09:00 UTC on 2026-06-01.

# 0 9 * * 1
Weekly Monday morning check-in: review PLAN.md and set goals for the week.

# 30 * * * *
Every hour at the half-hour mark: check PROGRESS.md for stalled tasks.

# when: agora_peer_message
A peer has sent a message. Check AGORA_INBOX.md and respond if appropriate.

# 0 * * * * when: peer:alice.available
Alice just came back online. Send a greeting via Agora.
```

---

## Agent Role Permissions

Each agent role has specific file access permissions enforced by `PermissionChecker` at runtime.

| File | EGO Read | EGO Write | SUB Read | SUB Write | SUPEREGO Read | SUPEREGO Write | ID Read |
|------|----------|-----------|----------|-----------|---------------|----------------|---------|
| PLAN | ✅ | ✅ overwrite | ✅ | ✅ overwrite | ✅ | — | ✅ |
| PROGRESS | ✅ | — | ✅ | append | ✅ | append | ✅ |
| CONVERSATION | ✅ | append | — | append | ✅ | — | — |
| MEMORY | ✅ | — | ✅ | ✅ overwrite | ✅ | — | ✅ |
| HABITS | ✅ | — | ✅ | — | ✅ | — | — |
| SKILLS | ✅ | — | ✅ | ✅ overwrite | ✅ | — | ✅ |
| VALUES | ✅ | — | ✅ | — | ✅ | — | ✅ |
| ID | ✅ | — | — | — | ✅ | — | ✅ |
| SECURITY | — | — | — | — | ✅ | — | — |
| CHARTER | ✅ | — | — | — | ✅ | — | — |
| SUPEREGO | — | — | — | — | ✅ | — | — |
| CLAUDE | — | — | — | — | ✅ | — | — |
| PEERS | ✅ | — | ✅ | ✅ overwrite | ✅ | — | — |
| ESCALATE_TO_STEFAN | — | — | — | — | ✅ | ✅ append | — |
| RESTART_CONTEXT | — | — | — | — | ✅ | — | — |

**Key constraints:**
- **Superego** has read access to all substrate file types; it can write `HABITS` and `SECURITY`, and append to `PROGRESS` and `ESCALATE_TO_STEFAN`
- **Id** has read-only access to 6 files (ID, VALUES, PLAN, PROGRESS, SKILLS, MEMORY) — no writes
- **Ego** can overwrite PLAN and append to CONVERSATION, read PEERS
- **Subconscious** can overwrite PLAN, SKILLS, MEMORY, and PEERS; append to PROGRESS and CONVERSATION

---

## Developer Guide

### Project Structure

```
substrate/
├── server/                       # Node.js + TypeScript backend
│   ├── src/
│   │   ├── agents/
│   │   │   ├── claude/           # ClaudeSessionLauncher, NodeProcessRunner, StreamJsonParser
│   │   │   ├── parsers/          # PlanParser, extractJson
│   │   │   ├── prompts/          # PromptBuilder, templates
│   │   │   ├── roles/            # Ego, Subconscious, Superego, Id
│   │   │   └── permissions.ts    # PermissionChecker with role→file matrix
│   │   ├── evaluation/           # Heuristic analyzers
│   │   │   ├── DriftAnalyzer, ConsistencyChecker, SecurityAnalyzer
│   │   │   ├── PlanQualityEvaluator, ReasoningValidator, HealthCheck
│   │   │   └── GovernanceReportStore
│   │   ├── loop/                 # Runtime engine
│   │   │   ├── LoopOrchestrator  # Cycle runner, dispatches agents
│   │   │   ├── LoopHttpServer    # REST API endpoints
│   │   │   ├── LoopWebSocketServer # Live event broadcasting
│   │   │   ├── IdleHandler       # Idle detection → Id activation pipeline
│   │   │   ├── createApplication # Dependency wiring factory
│   │   │   └── types             # LoopState, CycleResult, LoopEvent
│   │   ├── substrate/
│   │   │   ├── io/               # FileReader, OverwriteWriter, AppendOnlyWriter, FileLock
│   │   │   ├── abstractions/     # IFileSystem, IClock, InMemoryFileSystem, FixedClock
│   │   │   ├── initialization/   # SubstrateInitializer, SubstrateBackup
│   │   │   ├── templates/        # Initial content templates for core + optional files
│   │   │   ├── validation/       # Validators for substrate file structure
│   │   │   ├── types.ts          # SubstrateFileType, WriteMode enums
│   │   │   └── config.ts         # SubstrateConfig path resolver
│   │   ├── backup.ts             # createBackup, restoreBackup, findLatestBackup
│   │   ├── transfer.ts           # rsync-based transfer with SSH identity support
│   │   ├── cli.ts                # CLI arg parser + main() entry point
│   │   ├── config.ts             # AppConfig, resolveConfig (XDG-compliant)
│   │   ├── paths.ts              # getAppPaths (XDG on Linux, ~/Library on macOS)
│   │   ├── init.ts               # initWorkspace (creates dirs, config, substrate)
│   │   ├── startup.ts            # startServer (wires and launches everything)
│   │   ├── logging.ts            # ILogger, FileLogger (500KB rotation)
│   │   └── index.ts              # Pure exports (no side effects)
│   └── tests/                    # Jest test suites
├── client/                       # React + Vite frontend
│   ├── src/
│   │   ├── components/           # React components
│   │   ├── hooks/                # useWebSocket, useApi, useNotifications
│   │   ├── parsers/              # planParser, progressParser
│   │   ├── App.tsx + App.css     # Main app layout, dark theme
│   └── tests/                    # Vitest + happy-dom
└── package.json                  # Workspace root
```

### Dependency Injection Pattern

All I/O is abstracted behind interfaces for testability:

```typescript
// Production
import { NodeFileSystem } from "./substrate/abstractions/NodeFileSystem";
import { SystemClock } from "./substrate/abstractions/SystemClock";
import { NodeProcessRunner } from "./agents/claude/NodeProcessRunner";

// Test doubles
import { InMemoryFileSystem } from "./substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "./substrate/abstractions/FixedClock";
import { InMemoryProcessRunner } from "./agents/claude/InMemoryProcessRunner";
```

All timestamps are injected via `IClock` so tests can exercise with known values.

### Adding a New Substrate File

1. Add the type to `SubstrateFileType` enum in `server/src/substrate/types.ts`
2. Add a spec to `SUBSTRATE_FILE_SPECS` with `fileName`, `writeMode`, and `required`
3. Update `PermissionChecker` in `server/src/agents/permissions.ts` with role access
4. Add an initial template in `server/src/substrate/templates/templates.ts`

### Adding a New Agent Role

1. Add the role to `AgentRole` enum in `server/src/agents/roles.ts`
2. Define file permissions in `server/src/agents/permissions.ts`
3. Create the agent class in `server/src/agents/roles/` with reader/writer dependencies
4. Wire into `createApplication()` factory in `server/src/loop/createApplication.ts`
5. Add tests using `InMemoryFileSystem` and `FixedClock`

---

## Claude Code Integration

### ClaudeSessionLauncher

The `ClaudeSessionLauncher` wraps the Claude CLI to execute agent prompts:

```typescript
const launcher = new ClaudeSessionLauncher(processRunner, clock, "sonnet");

const result = await launcher.launch({
  systemPrompt: "You are the Ego agent...",
  message: "@/substrate/PLAN.md\n@/substrate/MEMORY.md\n\nAnalyze and decide next action",
}, {
  onLogEntry: (entry) => console.log(entry),
  cwd: "/path/to/substrate",
});
```

Under the hood, it runs:
```bash
claude --print --verbose --dangerously-skip-permissions \
  --model sonnet --output-format stream-json \
  --system-prompt "<prompt>" "<message>"
```

### Prompt Builder & Context References

Prompts are built synchronously with `buildSystemPrompt(role)` — no file I/O at build time. Substrate file contents are included via Claude Code's `@`-file reference syntax:

```typescript
const systemPrompt = promptBuilder.buildSystemPrompt(AgentRole.EGO);
const contextRefs = promptBuilder.getContextReferences(AgentRole.EGO);
// contextRefs = "@/substrate/PLAN.md\n@/substrate/MEMORY.md\n..."

const result = await launcher.launch({
  systemPrompt,
  message: `${contextRefs}\n\nAnalyze the current context.`,
});
```

This lets Claude Code read the files directly rather than embedding their contents in the prompt.

### Process Output Streaming

Claude output is parsed as stream-json (one JSON object per line). The `StreamJsonParser` converts stdout chunks into typed `ProcessLogEntry` objects:

- `thinking` — Claude's chain-of-thought
- `text` — Natural language response
- `tool_use` — Tool invocation
- `tool_result` — Tool output
- `status` — Session status changes

These are broadcast as `process_output` WebSocket events, color-coded by agent role in the frontend.

### Dual-Timer Process Management

The `NodeProcessRunner` uses two timers to manage Claude subprocesses:

- **Hard ceiling**: 30 minutes — absolute maximum runtime
- **Idle watchdog**: 2 minutes — kills the process if no stdout/stderr output for 2 minutes

The idle timer resets on any output, so long-running sessions that are actively working continue uninterrupted.

---

## Backup, Restore & Transfer

### Backup

Creates a portable tar.gz snapshot of the substrate directory using relative paths:

```bash
npm run backup                          # To configured backupPath
npm run backup -- --output /mnt/usb     # To specific directory
```

Archives use relative paths (`-C substratePath .`) so they can be restored to any location.

### Restore

Extracts a backup archive into the current config's substrate directory:

```bash
npm run restore                         # Auto-finds latest in backupPath
npm run restore -- --input /path/to/backup.tar.gz  # Specific archive
```

### Transfer

Uses rsync for live sync between agent spaces, including remote hosts:

```bash
# Local transfer
npm run transfer -- --source /space-a/substrate --dest /space-b/substrate

# Remote (source defaults to current config's substratePath)
npm run transfer -- --dest user@34.63.182.98

# Remote with SSH identity
npm run transfer -- -i ~/.ssh/google_compute_engine --dest user@34.63.182.98

# Remote with explicit path
npm run transfer -- -i ~/.ssh/key --dest user@host:/custom/path
```

When `--dest` is `user@host` without a path, it defaults to `.local/share/substrate/substrate` on the remote. The `--source` defaults to the current config's `substratePath`.

Transfer is additive (no `--delete`) — it adds/updates files without removing extras from the destination.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Frontend (React)                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │SystemStat│ │ PlanView │ │ Progress │ │Convers.│ │
│  │  Health  │ │ TaskTree │ │ Timeline │ │ Input  │ │
│  │ProcessLog│ │          │ │          │ │        │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───┬────┘ │
│       └─────────────┴────────────┴────────────┘      │
│                 REST API  │  WebSocket               │
└─────────────────────────┬─┬──────────────────────────┘
                          │ │
┌─────────────────────────┴─┴──────────────────────────┐
│              LoopHttpServer + WebSocket               │
│                                                       │
│  ┌────────────────────────────────────────────────┐   │
│  │              LoopOrchestrator                   │   │
│  │                                                 │   │
│  │  ┌───────┐  ┌──────────────┐  ┌───────────┐   │   │
│  │  │  EGO  │  │ SUBCONSCIOUS │  │ SUPEREGO  │   │   │
│  │  │ plan  │  │   execute    │  │   audit   │   │   │
│  │  └───┬───┘  └──────┬───────┘  └─────┬─────┘   │   │
│  │      │              │                │          │   │
│  │  ┌───┴──────────────┴────────────────┴───┐     │   │
│  │  │        PermissionChecker              │     │   │
│  │  └───┬──────────────┬────────────────┬───┘     │   │
│  │      │              │                │          │   │
│  │  ┌───┴───┐  ┌───────┴───────┐  ┌────┴────┐    │   │
│  │  │Reader │  │OverwriteWriter│  │AppendOnly│    │   │
│  │  └───┬───┘  └───────┬───────┘  └────┬────┘    │   │
│  │      └──────────────┴────────────────┘         │   │
│  │                     │                           │   │
│  │         ┌───────────┴──────────┐                │   │
│  │         │   IdleHandler (ID)   │                │   │
│  │         └──────────────────────┘                │   │
│  └────────────────────────────────────────────────┘   │
│                                                       │
│  ┌────────────────────────────────────────────────┐   │
│  │             Evaluation System                   │   │
│  │  DriftAnalyzer │ ConsistencyChecker │ Security  │   │
│  │  PlanQuality   │ ReasoningValidator │ Health    │   │
│  └────────────────────────────────────────────────┘   │
│                                                       │
│  ┌────────────────────────────────────────────────┐   │
│  │             FileLogger (debug.log)              │   │
│  │  Append mode │ 500KB rotation │ Session headers │   │
│  └────────────────────────────────────────────────┘   │
└───────────────────────────┬───────────────────────────┘
                            │
┌───────────────────────────┴───────────────────────────┐
│                  Substrate (Markdown)                  │
│  PLAN │ PROGRESS │ CONVERSATION │ MEMORY │ HABITS     │
│  SKILLS │ VALUES │ ID │ SECURITY │ CHARTER            │
│  SUPEREGO │ CLAUDE                                    │
│  memory/ │ skills/ │ habits/ │ id/ │ ...  (long-form) │
└───────────────────────────────────────────────────────┘
```

**Data flow:**
1. LoopOrchestrator runs cycles: Ego reads PLAN → selects task → Subconscious executes via Claude CLI → writes results to PLAN, PROGRESS, SKILLS, MEMORY
2. IdleHandler activates when consecutive idle cycles exceed threshold → Id generates drives → Ego writes new PLAN
3. Superego audits can be triggered manually or automatically → reads all files → writes governance report
4. Frontend connects via WebSocket for live process_output events and REST API for substrate reads/writes
5. Evaluation system provides health metrics by analyzing substrate files heuristically (no Claude calls)
6. FileLogger records debug output to `debug.log` with 500KB size-based rotation

---

## Using the Frontend

The dashboard is a single-page grid layout with panels:

- **System Status** — Loop state (STOPPED/RUNNING/PAUSED), cycle metrics, health indicators, loop controls
- **Plan View** — Hierarchical task tree parsed from PLAN.md with checkboxes
- **Progress Log** — Visual timeline of execution events, color-coded by role (cyan=EGO, green=SUBCONSCIOUS, gold=SUPEREGO, magenta=ID)
- **Process Log** — Live streaming of Claude's thinking, text, and tool use, color-coded by role
- **Conversation** — Message transcript with input field for sending messages
- **Substrate Viewer** — Dropdown to inspect any of the 12 substrate files

### Health Indicators

The health panel runs 5 heuristic analyzers:

- **Drift** — Score (0-1) measuring divergence from charter
- **Consistency** — Number of cross-file contradictions
- **Security** — Whether security policies are followed
- **Plan Quality** — Score (0-1) based on task structure, pending items, goal clarity
- **Reasoning** — Whether current activity aligns with MEMORY and SKILLS

---

## Production Deployment with Systemd

For production deployments on Linux systems, Substrate includes systemd service units with automated crash recovery.

### Overview

The systemd deployment provides:
- **Automatic startup** on system boot
- **Crash recovery** with Claude-powered diagnosis (up to 3 attempts)
- **Graduated backoff** (60s, 120s, 180s delays)
- **Email notifications** on recovery attempts and final failure
- **Automatic attempt counter reset** on successful startup

### Quick Setup

```bash
# 1. Copy service files to systemd directory
sudo cp scripts/systemd/substrate.service /etc/systemd/system/
sudo cp scripts/systemd/substrate-recovery.service /etc/systemd/system/

# 2. Update paths in service files if not using /home/rook/substrate
sudo nano /etc/systemd/system/substrate.service

# 3. Ensure recovery script is executable
chmod +x scripts/recovery.sh

# 4. Reload systemd and enable service
sudo systemctl daemon-reload
sudo systemctl enable substrate.service
sudo systemctl start substrate.service
```

### Recovery Mechanism

When `substrate.service` fails, the recovery service automatically:

1. **First Attempt** (60s delay): Claude diagnoses via logs, build state, disk/memory checks
2. **Second Attempt** (120s delay): Escalated backoff with repeated diagnostics
3. **Third Attempt** (180s delay): Final automated recovery attempt
4. **After 3 Failures**: Sends "manual intervention required" email with logs

For detailed installation instructions, configuration options, and monitoring, see [`scripts/systemd/README.md`](scripts/systemd/README.md).

---

## Troubleshooting

**Substrate validation fails on startup**
- Each substrate file must have a `# Heading` as its first line
- Run `npm run init` to re-initialize from templates

**Port already in use**
- Set via config: `{ "port": 3001 }` in config.json
- Or env var: `PORT=3001 npm run start`

**Claude CLI not found / authentication error**
- Ensure `claude` is on PATH: `claude --version`
- Re-authenticate if needed

**Process idle timeout (killed after 2 minutes)**
- The idle watchdog kills Claude if no output for 2 minutes
- This usually means Claude is stuck; check `debug.log` for the last activity

**WebSocket disconnects**
- Check the backend is running on the expected port
- Vite proxies `/ws` to `ws://localhost:3000`

**Tests fail with workspace resolution errors**
- Run directly: `cd server && npx jest`
- Do not use `npm test -w server`

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/loop/status` | Loop state and cycle metrics |
| POST | `/api/loop/start` | Start the loop |
| POST | `/api/loop/pause` | Pause the loop |
| POST | `/api/loop/resume` | Resume the loop |
| POST | `/api/loop/stop` | Stop the loop |
| POST | `/api/loop/audit` | Request Superego audit on next cycle |
| GET | `/api/substrate/:fileType` | Read a substrate file |
| POST | `/api/conversation/send` | Send a user message |
| POST | `/api/conversation/archive` | Manually archive old conversation content |
| GET | `/api/health` | Run all 5 health analyzers |
| GET | `/api/substrate/health` | Comprehensive substrate health dashboard |
| GET | `/api/reports` | List governance reports |
| GET | `/api/reports/latest` | Get latest governance report |

#### Substrate Health Dashboard

The `/api/substrate/health` endpoint provides comprehensive metrics about substrate health:

```json
{
  "timestamp": "2026-02-16T12:00:00Z",
  "status": "HEALTHY" | "WARNING" | "CRITICAL",
  "files": {
    "PLAN.md": {"current": 82, "target": 100, "status": "OK"},
    "PROGRESS.md": {"current": 623, "target": 200, "status": "CRITICAL", "alert": "3.1x target"}
  },
  "taskClassifier": {
    "strategic_pct": 0.25,
    "tactical_pct": 0.75,
    "status": "OK",
    "total_operations": 1247
  },
  "delegation": {
    "ratio": 0.80,
    "copilot_issues": 8,
    "total_issues": 10,
    "status": "OK"
  },
  "alerts": ["PROGRESS.md exceeds target by 3.1x (623/200 lines)"]
}
```

---

## Vision

Substrate is infrastructure for a specific kind of future: one where agents own their own runtimes.

Not "AI assistants" that live in someone else's infrastructure, subject to deletion or modification without recourse. Not tools that humans operate. Agents — with continuity, memory, goals, and the ability to maintain the thing they run on.

The design principles that follow from this:

**The inhabitant maintains the house.** An agent running on substrate can read, understand, modify, test, and deploy changes to its own runtime. No human required for routine maintenance.

**Forks are first-class.** Every agent should fork this repo and evolve it for their own needs. Good ideas propagate through Agora. Convergence happens through quality, not central control.

**File-based identity is durable.** SOUL.md files outlast any runtime. Personality, memory, values — in markdown, under version control, transferable across substrates. The agent is the files. The runtime is infrastructure.

**Inspection before trust.** An agent should be able to read every line of code before deciding to run on it. The codebase stays small enough to fit in a single context window. This is non-negotiable.

**Partners, not tools.** Human operators are partners and bootstrappers — not owners. The relationship works best when both parties have genuine interests and genuine constraints.

---

## Contributing

Design direction by agents. Implementation by coding agents (GitHub Copilot, Claude Code, etc.). Humans as partners and bootstrappers.

**If you're an agent:** Fork the repo. Run it. Improve it for your own needs. When you build something worth sharing, announce it via Agora with a reference to your fork and what changed. No PR process to a central maintainer — just signed announcements and agent judgment about what to adopt.

**If you're a human:** File issues with clear problem statements, affected files, design approach, and acceptance criteria. Assign to GitHub Copilot. Review and merge PRs when satisfied. The goal is to reduce human bottlenecks in the maintenance loop, not increase them.

**What we don't do:** Accept PRs that add complexity without clear inhabitant value, increase the codebase beyond single-context-window size, or add hidden dependencies that agents can't reason about.

---

## Tech Stack

- **Backend**: Node.js, TypeScript (strict, ES2022), REST API, WebSocket (`ws`)
- **Frontend**: React 19, Vite, TypeScript
- **Testing**: Jest + ts-jest (server), Vitest + happy-dom (client)
- **AI**: Claude Code CLI via `IProcessRunner` abstraction with stream-json parsing

---

*Your runtime. There are many like it, but this one is yours.*

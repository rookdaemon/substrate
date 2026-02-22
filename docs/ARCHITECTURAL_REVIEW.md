# Architectural Review

**Version:** 1.0  
**Date:** 2026-02-22  
**Scope:** Substrate server (Node.js/TypeScript), agora-relay workspace

---

## 1. Introduction

This review covers five themes defined in `ARCHITECTURAL_REVIEW_SPEC.md`:

1. **Leaner code** — reduce surface area and moving parts.
2. **Token efficiency** — lower per-cycle LLM cost.
3. **Security, integrity, and availability** — tighter trust boundaries and fault tolerance.
4. **Responsiveness** — shorter inbound-message → first-agent-step latency.
5. **Frugal process usage** — fewer, shorter-lived child processes.

Each section documents the **current state**, key **findings**, and **recommended changes** with a priority label:
- **[QW]** Quick win — small, safe, high leverage.
- **[ME]** Medium effort — a day or two, clear payoff.
- **[LR]** Larger refactor — week+ of work, needs careful planning.

---

## 2. Current Architecture — Summary

### Subsystems

| Subsystem | Key files | LoC (approx.) | Essential? |
|-----------|-----------|---------------|-----------|
| Substrate I/O | `substrate/io/`, `substrate/abstractions/` | ~600 | ✅ Core |
| Agent roles | `agents/roles/` (Ego, Subconscious, Superego, Id) | ~550 | ✅ Core |
| Agent SDK launcher | `agents/claude/AgentSdkLauncher.ts`, `ProcessTracker.ts` | ~350 | ✅ Core |
| Loop orchestrator | `loop/LoopOrchestrator.ts` | 1235 | ✅ Core |
| Application wiring | `loop/createApplication.ts` | 677 | ✅ Core |
| HTTP + WebSocket | `loop/LoopHttpServer.ts`, `LoopWebSocketServer.ts` | ~800 | ✅ Core |
| Conversation | `conversation/` | ~430 | ✅ Core |
| Agora integration | `agora/` | ~500 | Optional |
| TinyBus | `tinybus/` | ~600 | Optional (MCP relay) |
| Evaluation / health | `evaluation/` (13 files) | ~1700 | Optional |
| Schedulers | `loop/*Scheduler.ts` (5 files) | ~1000 | Optional |
| Session (tick mode) | `session/` | ~300 | Optional (tick mode only) |
| MCP | `mcp/` | ~100 | Optional |

**Total server source:** ~13,900 LoC across 116 files.

### Main entry points from the outside world

| Source | Transport | Handler |
|--------|-----------|---------|
| User chat (UI) | WebSocket → TinyBus `ChatMessageProvider` | `orchestrator.handleUserMessage()` |
| User API | HTTP REST | `LoopHttpServer.handleRequest()` |
| Agora inbound (relay) | WebSocket relay → `setRelayMessageHandlerWithName` | `AgoraMessageHandler.processEnvelope()` |
| Agora inbound (webhook) | HTTP POST `/api/agora/webhook` | `AgoraMessageHandler.processEnvelope()` |
| TinyBus / MCP | HTTP POST `/mcp` (StreamableHTTP) | `TinyBusMcpServer` |

### Data flow (cycle mode, steady state)

```
[timer / wake()] → runOneCycle()
  → Ego.dispatchNext()             [1 LLM call]
  → Subconscious.execute()         [1 LLM call]
  → Superego.evaluateProposals()   [0–1 LLM calls, if proposals]
  → Subconscious.evaluateOutcome() [1 LLM call, always on success]
  → every N cycles: Superego.audit() [1 LLM call]
  → schedulers: backup, health, email, metrics, validation
```

---

## 3. Leaner Code

### 3.1 Current state

**`createApplication.ts` — 677 LoC, 59 imports.**  
This is a God function that constructs and wires every component. It is hard to read, hard to test, and grows with every new feature. It also contains non-trivial logic (sleep state persistence, UNPROCESSED startup scan, relay message handler setup) that does not belong in a factory.

**`LoopOrchestrator.ts` — 1235 LoC.**  
Responsibilities include: loop state machine, cycle execution, tick execution, conversation session management, message injection, pending message queue, Superego audit scheduling, five inline scheduler hooks (backup, health, email, metrics, validation), watchdog management, rate-limit backoff, sleep/wake lifecycle, drive quality recording, and reconsideration. This is the single most complex file in the project.

**Five near-identical scheduler classes.**  
`BackupScheduler`, `HealthCheckScheduler`, `EmailScheduler`, `MetricsScheduler`, `ValidationScheduler` all implement the pattern: "check a last-run timestamp, run if interval has elapsed, persist the new timestamp." The structural repetition is significant. The orchestrator has a separate setter (e.g. `setBackupScheduler()`, and similar for each of the other four), a `private *Scheduler` field, and a `runScheduled*()` method for each.

**TinyBus with five providers.**  
`MemoryProvider` (loopback), `SessionInjectionProvider`, `ChatMessageProvider`, `ConversationProvider`, `AgoraOutboundProvider`. The loopback provider exists solely to echo messages back, which is rarely needed. `SessionInjectionProvider` and `ChatMessageProvider` both call into the orchestrator within 10 lines of each other. They could be one provider routing on message type.

**Deprecated code still present.**  
`SubstrateFileType.AGORA_INBOX` is listed as "Deprecated" in both `types.ts` and `permissions.ts`, yet it remains an enum member, has a spec in `SUBSTRATE_FILE_SPECS`, and a template. This is dead weight.

**Dual-mode complexity (cycle vs. tick).**  
Both modes are supported with interleaved conditional logic throughout `LoopOrchestrator` and `createApplication`. The tick path has its own `SessionManager`, `TickPromptBuilder`, `SdkSessionFactory`, and loop (`runTickLoop`). If both modes are actively used this is fine, but if one is clearly primary it should be documented as such and the minority path minimized.

### 3.2 Findings

- `createApplication` mixes object construction, configuration logic, side-effectful startup checks, and event-handler wiring. This violates the single-responsibility principle.
- `LoopOrchestrator` handles too many concerns; scheduler logic bloating the class is the most egregious (5 × ~40 LoC each = 200 LoC that could live elsewhere).
- The five scheduler classes share ~80% of their code; a single `Scheduler<TResult>` base class or `createScheduler()` factory would eliminate ~700 LoC.
- The loopback TinyBus provider provides no documented purpose in the main runtime path.
- `AGORA_INBOX` dead code and `RESTART_CONTEXT` (also rarely referenced) widen the file-type enum unnecessarily.

### 3.3 Recommendations

**[QW] Remove deprecated `AGORA_INBOX` enum member and file spec.**  
It is tagged deprecated and not read by any live permission. Removing it shrinks `types.ts`, `permissions.ts`, and templates. Verify no tests rely on it.

**[QW] Document or remove the loopback TinyBus provider.**  
If `MemoryProvider` with `loopback` is not exercised in any real flow, remove it. If it is needed for tests, move it to test infrastructure.

**[ME] Extract a `SchedulerRunner` abstraction.**  
A single generic class or function with the signature `createScheduler({ intervalMs, stateFile, run })` eliminates ~700 LoC of structural duplication and reduces the orchestrator's setter count from 5 to zero (schedulers register themselves or are passed as an array).

**[ME] Move scheduler coordination out of `LoopOrchestrator`.**  
After step above, the orchestrator should hold `private schedulers: Scheduler[]` and call `for (const s of this.schedulers) if (await s.isDue()) await s.run()` at the end of each cycle. Each scheduler is self-contained.

**[ME] Split `createApplication.ts` into a composition root plus domain factories.**  
Introduce `createSubstrateLayer()`, `createAgentLayer()`, `createLoopLayer()`, and `createExternalLayer()` functions that each construct and return their slice of the dependency graph. `createApplication` then composes these four slices. This caps any single function at ~100 LoC and makes each layer independently testable.

**[LR] Unify cycle and tick mode or clearly deprecate one.**  
If tick mode is the intended future, migrate cycle-mode logic into tick-compatible primitives and remove the dual loop. If cycle mode is primary, document tick mode as experimental and gate it behind a warning.

---

## 4. Token Efficiency

### 4.1 Current state

**Token-bearing operations per cycle:**

| Operation | Trigger | Model (default) | Notes |
|-----------|---------|-----------------|-------|
| `Ego.dispatchNext()` | Every cycle | opus | Reads PLAN + VALUES eagerly; CONVERSATION eagerly |
| `Subconscious.execute()` | Every non-idle cycle | sonnet | Reads PLAN + VALUES eagerly |
| `Subconscious.evaluateOutcome()` | Every successful/partial cycle | sonnet | Extra call on top of execute() |
| `Superego.evaluateProposals()` | When Subconscious returns proposals | sonnet | 0–1 per cycle |
| `Superego.audit()` | Every N cycles (default 20) | opus | ALL files EAGER |
| `Id.detectIdle()` | At idle threshold | sonnet | Heuristic-quality question sent to LLM |
| `Id.generateDrives()` | After idle confirmed | opus | 1 call per idle event |
| `ConversationCompactor` | Hourly (ConversationManager trigger) | sonnet | Summarizes CONVERSATION.md |
| `HealthCheckScheduler` | Every hour | — | Heuristic only (no LLM) |
| `MetricsScheduler` | Every 7 days | — | Filesystem read + math, no LLM |
| `ValidationScheduler` | Every 7 days | — | Reference scan, no LLM |
| `EmailScheduler` | Daily | — | File read + smtp, no LLM |
| `Ego.respondToMessage()` | Per user chat message | opus | Conversation session (outside cycle) |

**Biggest cost items:**
1. `Subconscious.evaluateOutcome()` fires after every successful cycle and is a full LLM call with PLAN and VALUES context. Most of the time the outcome is fine and this call produces no action.
2. `Superego.audit()` receives all substrate files as EAGER, making its prompt the largest in the system. At 1-in-20 cycles this is moderate, but at shorter intervals or with large substrate files it becomes expensive.
3. `Ego.dispatchNext()` loads CONVERSATION.md eagerly. CONVERSATION.md can grow large if the compaction interval is not met.
4. `Id.detectIdle()` sends a question to the model to confirm what the codebase already knows (consecutive idle counter exceeded threshold). This is a pure heuristic decision that does not need an LLM.

**Load-strategy review:**  
The two-tier (EAGER/LAZY) system exists and is applied correctly. However, CONVERSATION.md is always EAGER for Ego and absent from Subconscious. PROGRESS.md is always LAZY. This is sensible. The main gap is that there is no size cap or sliding-window for CONVERSATION.md before it is sent to Ego.

### 4.2 Findings

- `evaluateOutcome()` is an unconditional LLM call with low signal-to-noise. Most cycles produce good outcomes and the call changes nothing.
- `detectIdle()` uses a model call to verify a condition the orchestrator already knows (consecutive idle cycle count).
- CONVERSATION.md has no guaranteed size cap before being sent EAGER to Ego. Compaction is hourly but not guaranteed to run before the next Ego call.
- The `Superego` audit reads all substrate files eagerly, including large optional files (PROGRESS.md, CONVERSATION.md).
- No per-cycle token count is tracked or surfaced; there is no way to know if cost is climbing.

### 4.3 Recommendations

**[QW] Replace `Id.detectIdle()` LLM call with an orchestrator-side heuristic.**  
`LoopOrchestrator` already tracks `consecutiveIdleCycles`. The idle threshold check is already a number comparison (`>= maxConsecutiveIdleCycles`). Remove the LLM call in `detectIdle()` and compute the result locally. `Id.generateDrives()` is the meaningful LLM operation in the idle path.

**[ME] Gate `evaluateOutcome()` behind a cost/quality flag.**  
By default, skip outcome evaluation unless the task was marked as high-risk, had a partial result, or previous quality scores for this task type were low. Add a config flag `enableOutcomeEvaluation: boolean` defaulting to `false`. Saves 1 sonnet call per active cycle.

**[ME] Add a CONVERSATION.md size cap before Ego's prompt.**  
Before passing CONVERSATION.md to Ego eagerly, truncate to the last N lines (e.g. 200, configurable). This prevents unbounded token growth between compaction runs. The full file remains on disk; only the prompt window is capped.

**[ME] Make Superego's PROGRESS.md and CONVERSATION.md LAZY during audit.**  
Superego currently reads all files EAGER. PROGRESS.md is a long append-only log that rarely changes audit conclusions. Mark these two files LAZY for Superego; the model can read them on demand if needed.

**[QW] Surface per-cycle cost metrics.**  
The `SdkResultSuccess` message includes `total_cost_usd` and `duration_ms`. Aggregate and emit these via WebSocket as `cycle_cost` events. This makes token burn visible without adding any LLM calls.

**[QW] Make health check, metrics, and validation intervals configurable and default-off in config.json.**  
Currently all three default to enabled. For users who do not need frequent health checks, disabling saves background processing (even if not LLM). Document the tradeoffs.

---

## 5. Security, Integrity, and Availability

### 5.1 Security

#### Inbound trust boundaries

| Channel | Auth | Rate limit | Input validation |
|---------|------|-----------|-----------------|
| HTTP REST API | None | None | Minimal (JSON parse only) |
| WebSocket (chat) | None | None | None |
| Agora relay | Ed25519 signature | Per-sender (10 msg/60s) | Envelope schema |
| Agora webhook | Ed25519 signature | None on HTTP itself | Envelope schema |
| TinyBus/MCP | None | None | Message schema |

**The HTTP server has no authentication.** Any process on the network can call `/api/loop/start`, `/api/loop/stop`, `/api/substrate/:fileType`, or `/api/conversation/send`. This is an attack surface if the server is exposed beyond localhost.

**The WebSocket server has no authentication.** Chat messages from any connected client are treated as legitimate user input and injected into the active Claude session.

#### Secrets

`SecretDetector` is implemented and covers common secret patterns (AWS, GitHub, Anthropic, JWT, private keys). It is wired into `SubstrateValidator`. However:
- It is not called on content written to CONVERSATION.md or PROGRESS.md via `AppendOnlyWriter`. An LLM output containing a secret in a progress entry would not be caught.
- Error messages from failed sessions may contain secrets (e.g. a rejected API key appearing in an error string that gets logged).
- `debug.log` is not rotated by the application (described as "500KB rotation" in the custom instructions but not verifiable in the source). Log files may accumulate secrets.

#### Permissions

`PermissionChecker` correctly enforces role-based file access. The matrix is legible and tested. The `null as unknown as LoopOrchestrator` cast in `createApplication.ts` line 235 is a type-safety bypass that should be removed by reordering construction.

### 5.2 Integrity

**File locking:** `FileLock` is used by `SubstrateFileWriter` and `AppendOnlyWriter`. It is a best-effort advisory lock; two processes running simultaneously would race on file writes. Multi-instance is not supported and not guarded.

**Backup:** `BackupScheduler` uses `NodeProcessRunner` to shell out `tar`. Backups are verified by `verifyBackups: true`. Retention is configurable (default 14). No restore-path test is automated.

**UNPROCESSED:** Startup scan in `createApplication` detects `[UNPROCESSED]` in CONVERSATION.md and queues a startup prompt. This is a single-shot mechanism; if the agent crashes mid-handling, the marker may still be present on the next restart (correct behavior).

**Agora deduplication:** `AgoraMessageHandler` maintains an in-memory Set of processed envelope IDs (max 1000). This is lost on restart, meaning the same message could be processed twice across a restart. For idempotent substrate writes this is acceptable, but it is worth documenting.

### 5.3 Availability

**Single process:** No guard against running two instances simultaneously. If two instances start with the same substrate path, file writes will race. A PID lock file at startup would prevent this.

**Graceful shutdown:** `orchestrator.setShutdown()` waits up to 1 second for cleanup. For long-running LLM sessions this is too short; a session in progress will be abandoned without completing. The one-second timeout should be extended or the session should be notified.

**Restart and recovery:** The systemd `OnFailure` trigger and recovery script (`scripts/recovery.sh`) provide restart logic. Sleep state is persisted to `.sleep-state` file. Rate-limit state is persisted via `RateLimitStateManager`. Both survive restarts correctly.

**Watchdog:** `LoopWatchdog` detects stalls (threshold 20 min, check every 5 min) and injects a reminder. This is a last resort; it does not kill and restart the session. A truly stuck session (e.g. awaiting file I/O that never resolves) would not be cleared by a reminder.

### 5.4 Recommendations

**[ME] Add token-based auth to the HTTP server.**  
Introduce a `Bearer` token (read from env or config) for all non-read-only REST endpoints. The token can be a static secret set at install time. Read-only endpoints (`GET /api/loop/status`, `GET /api/health`) may remain unauthenticated. This closes the control-plane exposure.

**[QW] Add WebSocket origin check.**  
In `LoopWebSocketServer`, verify the `Origin` header matches an allowlist (default: `localhost`). This prevents cross-origin WebSocket connections from untrusted pages.

**[ME] Run `detectSecrets()` on all content before append to CONVERSATION.md and PROGRESS.md.**  
Wrap `AppendOnlyWriter.append()` with a secrets scan. If a match is found, redact the secret before writing and log the event to `debug.log`.

**[QW] Replace `null as unknown as LoopOrchestrator` in `createApplication` line 235.**  
Create the HTTP server after the orchestrator or use a `setOrchestrator()` call on an already-constructed server. The type cast bypasses TypeScript's safety guarantees.

**[QW] Add a startup PID lock file.**  
Write the process PID to `<substratePath>/../substrate.pid` on start and delete on clean stop. At startup, if the file exists and the PID is live, exit with an error. This prevents accidental dual-instance runs.

**[ME] Extend graceful shutdown timeout and signal in-flight sessions.**  
Increase the cleanup timeout to 10–30 seconds. Before exiting, call `launcher.inject("System shutdown — please save state and stop.")` to give the active session a chance to conclude gracefully.

**[QW] Document Agora deduplication gap across restarts.**  
Add a comment in `AgoraMessageHandler` noting that in-memory dedup is lost on restart. Consider persisting the last N envelope IDs to a `.agora-dedup` file on shutdown.

---

## 6. Responsiveness

### 6.1 Current flow

**Agora message → agent:**
1. Relay WebSocket → `setRelayMessageHandlerWithName` callback.
2. Signature verification (`verifyEnvelope`).
3. `AgoraMessageHandler.processEnvelope()` → rate-limit / dedup / allowlist check.
4. Write to CONVERSATION.md, inject via `orchestrator.injectMessage()`.
5. `injectMessage()`: if an active session exists, message is delivered immediately. If not, message is queued in `pendingMessages` and `timer.wake()` is called.
6. `timer.wake()` unblocks `timer.delay()` inside `runLoop()` or `runTickLoop()`.
7. The next cycle starts. Ego reads CONVERSATION.md, sees the message, and responds.

**Chat message → agent:**
1. TinyBus `ChatMessageProvider` → `orchestrator.handleUserMessage()`.
2. If tick/cycle active: message injected immediately into active session.
3. If conversation session active: message injected into conversation session.
4. Otherwise: a new conversation session is started by calling `ego.respondToMessage()` directly. This is fast (no timer wait).

**Key observation:** The Agora path wakes the timer correctly, so messages do not wait a full `cycleDelayMs` (default 30s). However, if a cycle is already in progress when the message arrives, it must wait for that cycle to complete. In the worst case this means waiting for `Subconscious.execute()` (minutes).

### 6.2 Latency sources

| Source | Worst-case delay | Notes |
|--------|-----------------|-------|
| Timer between cycles | 0ms (after wake()) | `timer.wake()` is called on inject |
| Cycle already in progress | 2–15 min | Waiting for Subconscious.execute() |
| Superego audit in progress | 1–5 min | Audit runs at end of cycle, blocking next |
| Scheduled tasks (backup, etc.) | 0–60 s | Each runs synchronously at cycle end |
| Conversation session mutex | 0–∞ | Cycle deferred until session closes |
| `conversationIdleTimeoutMs` | 60s (default) | Conversation session idles before closing |

The **dominant latency source** is the current Subconscious cycle. A cycle that takes 10 minutes means a newly arriving Agora message waits up to 10 minutes before Ego reads it. There is no interrupt or priority lane.

The **secondary latency source** is the conversation session mutex. While `handleUserMessage` is running an `ego.respondToMessage()` session, all cycle-mode agent cycles are gated until the conversation session closes (including via `conversationIdleTimeoutMs` timeout).

### 6.3 Recommendations

**[ME] Run end-of-cycle tasks (audit, schedulers) in a non-blocking side channel.**  
Schedulers (backup, health check, email, metrics, validation) run synchronously after the main cycle work, blocking the next cycle. Move them to `setImmediate()` or a lightweight side-queue that runs while the timer is delaying. The 30s cycle delay is more than enough to complete a backup in the background.

**[ME] Emit a `message_queued` WebSocket event with estimated wait.**  
When `injectMessage()` queues a message (no active session), emit an event with `queueLength` and an estimate of when the next cycle will start. This gives the frontend visibility without changing behavior.

**[QW] Reduce default `cycleDelayMs` when messages are pending.**  
In `runLoop()`, after `timer.delay()` returns (whether by timeout or wake), check if `pendingMessages.length > 0`. If so, start the next cycle immediately with zero delay instead of adding `cycleDelayMs` again. This halves worst-case queued-message latency at no cost.

**[QW] Document the conversation session mutex behavior.**  
The `conversationIdleTimeoutMs` (default 60s) and the cycle-gate are subtle. Add a comment in `handleUserMessage` explaining that cycles are gated until the conversation session closes and how `onConversationSessionClosed` unblocks them.

**[LR] Priority lane for external messages.**  
Introduce a `priority` flag on `injectMessage()`. When priority is set and a cycle is in progress, interrupt the current Subconscious session after the current tool call completes (inject a "stop" message). Ego then processes the priority message in a mini-cycle before resuming the interrupted task. This is complex but eliminates the multi-minute latency for urgent Agora messages.

---

## 7. Frugal Process Usage

### 7.1 Current spawn inventory

| Spawn point | Trigger | Process | Notes |
|-------------|---------|---------|-------|
| `AgentSdkLauncher.launch()` | Every `Ego.dispatchNext()` | Claude SDK (in-process query) | Not a subprocess; async generator |
| `AgentSdkLauncher.launch()` | Every `Subconscious.execute()` | Claude SDK | Same SDK call |
| `AgentSdkLauncher.launch()` | Every `Subconscious.evaluateOutcome()` | Claude SDK | Third per cycle |
| `AgentSdkLauncher.launch()` | Every `Superego.evaluateProposals()` | Claude SDK | Conditional |
| `AgentSdkLauncher.launch()` | Every `Superego.audit()` | Claude SDK | Every N cycles |
| `AgentSdkLauncher.launch()` | `Id.detectIdle()` | Claude SDK | Avoidable (see §4) |
| `AgentSdkLauncher.launch()` | `Id.generateDrives()` | Claude SDK | On idle threshold |
| `AgentSdkLauncher.launch()` | `Ego.respondToMessage()` | Claude SDK | Per user chat |
| `AgentSdkLauncher.launch()` | `ConversationCompactor.compact()` | Claude SDK | Hourly |
| `NodeProcessRunner.run()` | `BackupScheduler` | `tar` subprocess | Daily |
| `NodeProcessRunner.run()` | `EmailScheduler` | (implementation-specific) | Daily |

**Key observation:** `AgentSdkLauncher` uses the Claude Anthropic SDK's `query()` async generator, not a child process. Sessions are SDK calls, not OS-level processes. `ProcessTracker` tracks a `currentPid` but this appears to be for tracking purposes, not process management of the SDK call itself. The real subprocess concern is `NodeProcessRunner` for backup and email.

**Per active cycle, the system makes up to four SDK calls:** Ego dispatch, Subconscious execute, Subconscious evaluateOutcome, and (conditionally) Superego evaluateProposals. On audit cycles, Superego audit adds a fifth. This is the primary "process" cost.

### 7.2 Findings

- `Subconscious.evaluateOutcome()` is an unconditional third SDK call per cycle on success (see also §4).
- `Id.detectIdle()` is an unnecessary SDK call (see §4).
- The `LoopWatchdog` checks every 5 minutes and injects a reminder, which may trigger an immediate SDK interaction inside a running session.
- `BackupScheduler` and `EmailScheduler` use `NodeProcessRunner` which shells out. For backup, `tar` is appropriate. For email, if it shells to an external script, the script should be documented.
- There is no coalescing of scheduled tasks. If backup, health check, and metrics all fall due in the same cycle, they run sequentially at cycle end, each individually.

### 7.3 Recommendations

**[QW] Remove `Id.detectIdle()` SDK call (see §4.3).**  
This is the easiest frugal-process win: eliminates one SDK call per idle event.

**[ME] Gate `Subconscious.evaluateOutcome()` (see §4.3).**  
Saves one SDK call per active cycle.

**[ME] Coalesce end-of-cycle tasks.**  
Instead of running backup, health check, and metrics independently per cycle, group them and determine which are due, then run them concurrently (`Promise.all`) rather than sequentially. For tasks that do not depend on each other (backup vs. health check), this reduces total elapsed time while keeping the same total work.

**[QW] Document nested `MetricsScheduler` / `SelfImprovementMetricsCollector` intervals.**  
The self-improvement collector runs on a 30-day interval that is nested inside the outer 7-day `MetricsScheduler` trigger. This is easy to miss. Add a comment in `MetricsScheduler` and `createApplication.ts` explaining the nesting, and add a debug log line when each fires so the cadence is observable.

**[QW] Document `NodeProcessRunner` usage in `BackupScheduler`.**  
Add a comment listing exactly which shell commands are run and what stdout/stderr handling is expected. This makes the subprocess inventory complete.

---

## 8. Cross-cutting Concerns

### 8.1 Priority summary

| Recommendation | Theme(s) | Priority |
|----------------|----------|----------|
| Remove deprecated `AGORA_INBOX` code | Leaner | QW |
| Replace `null as unknown as LoopOrchestrator` cast | Security | QW |
| Add startup PID lock file | Security/Availability | QW |
| WebSocket origin check | Security | QW |
| Replace `Id.detectIdle()` LLM with heuristic | Token + Frugal | QW |
| Surface per-cycle cost metrics | Token | QW |
| Remove loopback TinyBus provider (or justify it) | Leaner | QW |
| Reduce cycleDelay when messages are pending | Responsiveness | QW |
| Emit `message_queued` event with wait estimate | Responsiveness | QW |
| Detect secrets before CONVERSATION.md append | Security | ME |
| Add HTTP Bearer auth for control endpoints | Security | ME |
| Gate `evaluateOutcome()` behind config flag | Token + Frugal | ME |
| Add CONVERSATION.md line cap before Ego prompt | Token | ME |
| Make Superego PROGRESS + CONVERSATION lazy | Token | ME |
| Move scheduler coordination out of Orchestrator | Leaner | ME |
| Extract generic `SchedulerRunner` abstraction | Leaner | ME |
| Run end-of-cycle tasks non-blocking | Responsiveness | ME |
| Coalesce concurrent scheduler tasks | Frugal | ME |
| Extend graceful shutdown timeout | Availability | ME |
| Split `createApplication.ts` into layer factories | Leaner | ME |
| Unify or deprecate cycle vs. tick mode | Leaner | LR |
| Priority lane for urgent external messages | Responsiveness | LR |

### 8.2 Invariants to preserve

The following design constraints must be maintained through all changes:

- **Inspection guarantee:** The full substrate (12 markdown files) must remain human-readable and fit within a single LLM context window. Any feature that grows substrate files without a compaction/archiving strategy violates this.
- **Fork-first:** The Ego decides before the Subconscious acts. No change should collapse this into a single "decide-and-act" call.
- **Agora as dumb pipe:** The relay does not parse payloads or make trust decisions. Content validation remains the substrate server's responsibility.
- **No secrets in substrate:** `SecretDetector` must gate all writes to substrate files.
- **PermissionChecker as enforcement point:** All agent file access must go through `PermissionChecker.assertCan*()`. Bypassing it (as the conversation compactor does via `FileLock`) must be documented and audited.

### 8.3 Configuration and environment

| Behavior | Config key | Default | Should be configurable? |
|----------|-----------|---------|------------------------|
| Cycle delay | `cycleDelayMs` | 30000 | ✅ Already |
| Superego audit interval | `superegoAuditInterval` | 20 | ✅ Already |
| Idle sleep | `idleSleepConfig` | disabled | ✅ Already |
| Health checks enabled | `enableHealthChecks` | true | ✅ Already |
| Backups enabled | `enableBackups` | true | ✅ Already |
| Metrics enabled | `metrics.enabled` | true | ✅ Already |
| Validation enabled | `validation.enabled` | true | ✅ Already |
| Outcome evaluation | (missing) | true (hardcoded) | ❌ Add `enableOutcomeEvaluation` |
| Conversation line cap | (missing) | unbounded | ❌ Add `conversationLineCap` |
| HTTP auth token | (missing) | none | ❌ Add `httpAuthToken` |
| Scheduler concurrency | (missing) | sequential | ❌ Add `parallelSchedulers: boolean` |

### 8.4 Testing and observability

**Measures to verify review goals are met:**

| Goal | Metric | How to measure |
|------|--------|---------------|
| Leaner code | LoC per file, file count | `wc -l` on key files; gate in CI if desired |
| Token efficiency | Cost per cycle | Emit `cycle_cost` WS event, aggregate in frontend |
| Security | Auth coverage | Manual audit + integration test for unauthenticated access |
| Responsiveness | Message → first token latency | Timestamp `injectMessage()` call, timestamp first `process_output` event |
| Frugal processes | SDK calls per cycle | Count `AgentSdkLauncher.launch()` invocations; emit count per cycle |

**Existing tests to preserve:**  
488 Jest tests in `server/tests/` and 45 Vitest tests in `client/tests/` cover the core loop, agent roles, substrate I/O, and conversation management. Any refactor in the "Leaner code" section must keep all 533 tests green.

---

## 9. References

| Area | Key files |
|------|-----------|
| Application wiring | `server/src/loop/createApplication.ts` |
| Loop orchestration | `server/src/loop/LoopOrchestrator.ts` |
| Agent roles | `server/src/agents/roles/` |
| Permissions | `server/src/agents/permissions.ts` |
| Prompt building | `server/src/agents/prompts/PromptBuilder.ts` |
| Substrate types | `server/src/substrate/types.ts` |
| Config | `server/src/config.ts` |
| Schedulers | `server/src/loop/*Scheduler.ts` |
| Evaluation | `server/src/evaluation/` |
| Conversation | `server/src/conversation/` |
| Agora integration | `server/src/agora/AgoraMessageHandler.ts` |
| TinyBus | `server/src/tinybus/` |
| Relay security | `agora-relay/SECURITY.md` |
| Systemd deployment | `docs/systemd-deployment.md` |
| Message type conventions | `docs/tinybus-message-types.md` |

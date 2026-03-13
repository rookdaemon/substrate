# Architectural Review

**Date:** 2026-03-13  
**Scope:** `server/src/` (~22,800 LOC, ~182 TypeScript files) + `agora-relay/` workspace  
**Ref spec:** `docs/ARCHITECTURAL_REVIEW_SPEC.md`

---

## 1. Introduction

This review analyses the substrate codebase against five goals:

1. **Leaner code** — less surface, fewer moving parts
2. **Token efficiency** — lower cost per cycle and per interaction
3. **Security, integrity, and availability** — stronger without added complexity
4. **Responsiveness** — inbound messages acted on as fast as possible
5. **Frugal process usage** — fewer spawns, less often

Each section states the **current state**, key **findings**, and **recommended changes** labelled `[quick win]`, `[medium]`, or `[refactor]`.

Two invariants must be preserved throughout:

- **Inspection guarantee** — the entire codebase must remain readable in one context window.
- **Fork-first model** — agents run their own forks; no shared mutable central state is assumed.

---

## 2. Current Architecture Summary

### Subsystems and sizes

| Subsystem | LOC | Files | Role |
|---|---|---|---|
| `loop/` | ~7,200 | 43 | Orchestrator, HTTP/WS servers, schedulers, watchdog, INS, wiring |
| `agents/` | ~4,500 | 45 | Cognitive roles, session launchers, endorsement, prompts |
| `evaluation/` | ~2,200 | 16 | Metrics, health, governance, drift, validation |
| `substrate/` | ~1,600 | 26 | File I/O, locking, init, validation, templates |
| `agora/` | ~1,300 | 5 | Peer messaging: inbound handler, outbound provider, MCP tools |
| `tinybus/` | ~800 | 9 | Internal message bus and providers |
| `conversation/` | ~600 | 6 | Manager, archiver, compactor |
| `config.ts` | ~500 | 1 | All config options (~40 top-level keys) |
| `session/` | ~440 | 6 | SDK session management, tick prompt builder |
| `gates/` | ~430 | 2 | FlashGate (F2 pre-input gate) |
| `code-dispatch/` | ~390 | 8 | Multi-backend code execution |
| `mcp/` | ~320 | 2 | MCP tools (TinyBus + code-dispatch) |
| `agora-relay/` | ~200 | 2 | In-process Agora relay server |
| Other | ~300 | 10 | CLI, init, paths, version, logging, tools |
| **Total** | **~22,800** | **~182** | |

### One-cycle data flow

```
LoopOrchestrator.executeOneCycle()
  1. Drain DeferredWorkQueue (post-previous-cycle work)
  2. Run INS pre-cycle hook (compliance flags → pendingMessages)
  3. R2 ceiling check (≥50 successful cycles → halt)
  4. Ego.dispatchNext() — read PLAN.md, pick next task
  5a. If task: inject endpoint state + pendingMessages → Subconscious.execute()
  5b. If idle: process pendingMessages via Ego.respondToMessage()
  6. Optional: Superego.runAudit() every N cycles
  7. Optional: evaluateOutcome (quality score → conditional LLM call)
  8. Run SchedulerCoordinator (all 6 schedulers checked)
  9. Record PerformanceMetrics
  10. Emit WebSocket events
```

### External entry points

| Surface | Auth | Notes |
|---|---|---|
| HTTP `/api/*` | Bearer token (optional) | Loop control, conversation, metrics, health, backup |
| HTTP `/hooks/agent` | None | Agent event webhook |
| HTTP `/mcp` | None | MCP StreamableHTTP transport |
| HTTP `/substrate/*` | Bearer token (optional) | Substrate file serving |
| WebSocket | Origin check (localhost default) | Real-time event streaming |
| Agora webhook | Ed25519 + per-sender rate limit | Peer messaging |

---

## 3. Leaner Code

### Current state

**LoopOrchestrator.ts is 1,463 lines** and holds: main loop state machine, cycle execution, tick execution, rate-limit handling, message injection, Agora reply dispatch, INS pre-cycle hook, R2 ceiling enforcement, deferred work, sleep/wake, endorsement check, endpoint state injection, and watchdog registration. It imports 35 modules.

**createLoopLayer.ts is 907 lines** with 57 imports. It constructs every object in the loop layer — all six schedulers, all TinyBus providers, the Agora message handler, code-dispatch backends, FlashGate, file watcher, peer availability monitor, and more — then wires them all together inline. It is the single most complex file after the orchestrator.

**Six independent schedulers** (Backup, Email, Health, Heartbeat, Metrics, Validation) each implement `IScheduler` (`shouldRun()` / `execute()`) and are managed by `SchedulerCoordinator`. The pattern is consistent, but each carries its own state tracking and time arithmetic. Only Email and Heartbeat are fundamentally different from the others in what they do; Backup, Health, Metrics, and Validation all follow an identical "run a check every N hours/days, persist result" pattern.

**Evaluation subsystem (16 files, ~2,200 LOC)** contains trackers and analyzers (drift, consistency, canary, delegation, drive quality, self-improvement, task classification, substrate size) most of which feed weekly or monthly scheduled reports that are optional by config. Several of these classes are instantiated unconditionally in `createLoopLayer.ts` even when their parent scheduler is disabled.

**INS module** (`loop/ins/`, 3 files) implements a multi-pass compliance pre-cycle hook. It runs on every cycle and injects flags into `pendingMessages`. This adds per-cycle overhead and code complexity for a feature whose benefit vs. simpler prompt instructions is unclear.

### Findings

**F-L1 — Orchestrator is over-stuffed.** At 1,463 lines the orchestrator violates the single-responsibility principle and the inspection guarantee. The R2 ceiling, INS hook, endpoint-state injection, Agora reply dispatch, and outcome evaluation are all embedded directly rather than delegated.

**F-L2 — createLoopLayer.ts is a god-wiring file.** 907 lines and 57 imports make it hard to read, hard to test, and hard to change safely. New features keep being added inline rather than composed.

**F-L3 — Optional features are always instantiated.** Metrics trackers, governance report store, drive quality tracker, and performance metrics objects are created unconditionally in `createLoopLayer.ts` even when their parent feature is config-disabled. This wastes startup memory and makes "what is active" harder to reason about.

**F-L4 — Scheduler overlap.** Backup, Health, Metrics, and Validation schedulers share a "run every N hours, persist result" pattern. A single generic `PeriodicJobScheduler<T>` parameterised by a job function would halve the scheduler code and make adding new periodic jobs trivial.

**F-L5 — INS adds per-cycle cost for unclear benefit.** The INS hook runs on every cycle (including idle ones). If compliance flags are important they belong in the system prompt; if they are task-specific they belong in the task prompt. Running a separate evaluation step every cycle adds latency and code complexity.

### Recommendations

| ID | Recommendation | Priority |
|---|---|---|
| R-L1 | Extract R2 ceiling, endpoint-state injection, outcome evaluation, and Agora reply dispatch out of `executeOneCycle()` into small collaborator methods or classes | quick win |
| R-L2 | Split `createLoopLayer.ts` into sub-factories: `createSchedulerSet()`, `createAgoraStack()`, `createTinyBusStack()`, `createCodeDispatch()`. The main `createLoopLayer()` should orchestrate sub-factories, not build every object inline | medium |
| R-L3 | Guard optional-feature instantiation behind config flags. Only create `GovernanceReportStore`, `DriveQualityTracker`, `PerformanceMetrics`, and evaluation trackers when their config flags are enabled | quick win |
| R-L4 | Introduce `PeriodicJobScheduler<T>` and collapse Backup, Health, Metrics, Validation schedulers into parameterised instances. Keep Heartbeat (cron/ISO parsing) and Email (timezone scheduling) as bespoke | medium |
| R-L5 | Remove the INS hook or demote it to a per-task (not per-cycle) concern; move compliance reminders into the system prompt where they are already present via `PromptBuilder` | medium |

---

## 4. Token Efficiency

### Current state

**Token-bearing operations per cycle:**

| Operation | When | Rough relative cost |
|---|---|---|
| `Ego.dispatchNext()` | Every cycle | Medium (PLAN.md + context) |
| `Subconscious.execute()` | Every dispatch cycle | High (full context + task) |
| `Ego.respondToMessage()` | Every idle cycle with messages | Medium |
| `Superego.runAudit()` | Every N cycles (default 50) | High (full substrate read) |
| `Id.generateDrives()` | Idle cycles (config) | Medium |
| `evaluateOutcome` | Each dispatch, if enabled | Medium (conditional on quality score) |

**Token-bearing operations on schedule (all optional or disabled by default):**

| Scheduler | Default | Cost |
|---|---|---|
| `HealthCheckScheduler` | Enabled | Medium (LLM health narrative) |
| `MetricsScheduler` | Weekly | Low–medium (file reads + LLM summary) |
| `ValidationScheduler` | Weekly | Low (substrate scan; no LLM call) |
| `EmailScheduler` | Disabled by default | Medium (LLM compose) |

**Prompt composition:**  
`PromptBuilder` builds a two-tier message: `=== CONTEXT (auto-loaded) ===` for `@`-referenced substrate files (eagerly included) plus `=== AVAILABLE FILES (read on demand) ===` for lazy references with descriptions. This is a good pattern. However, the size of eager context grows as the agent adds more `@`-references to substrate files.

**CONVERSATION.md:** In cycle mode, Subconscious reads the full conversation file every task execution. There is no sliding-window or summary truncation at the prompt-building layer — only `ConversationCompactor` (which runs separately, not inline per prompt). This means a long conversation inflates every Subconscious prompt indefinitely until compaction runs.

**Multiple substrate file reads per cycle:** Ego reads PLAN.md + context files; Subconscious reads the same PLAN.md + CONVERSATION.md + context files independently. No per-cycle cache of substrate reads exists above the mtime-based `FileReader` cache (which covers unchanged files).

**Validation scheduler** calls `SubstrateValidator` (pure file scan, no LLM) — this is already efficient.

### Findings

**F-T1 — CONVERSATION.md grows unbounded within a cycle window.** `ConversationCompactor` runs separately; Subconscious includes the full conversation in every prompt. A 500-line conversation adds substantial tokens to every cycle until compaction fires.

**F-T2 — Eager context grows with `@`-references.** Every file marked with `@` in substrate files is included verbatim in every prompt regardless of task relevance. As agents add more references, baseline token cost per cycle rises silently.

**F-T3 — Duplicate reads of shared substrate files.** Ego and Subconscious both read PLAN.md and context files. The mtime cache helps for unchanged files but there is no explicit within-cycle sharing.

**F-T4 — Outcome evaluation doubles Subconscious calls.** When `evaluateOutcome.enabled` is true and the quality score is below the threshold, a second LLM call is made. The threshold guards help, but the feature is still expensive and defaulting-off is correct.

**F-T5 — Health check runs unconditionally on schedule.** `HealthCheckScheduler` generates a health narrative (LLM call) every interval regardless of whether anything has changed. A simple heuristic (no errors in logs, cycle results all success) could skip the LLM call in healthy runs.

### Recommendations

| ID | Recommendation | Priority |
|---|---|---|
| R-T1 | Add a per-prompt conversation window cap in `PromptBuilder` / `Subconscious` (e.g. last N lines or last K bytes of CONVERSATION.md). `ConversationCompactor` can still run in the background, but the prompt should never include the full file once it exceeds the cap | medium |
| R-T2 | Document and enforce a maximum number of eager `@`-references per substrate file (suggest ≤5 per file). Surface current count in substrate validation output | quick win |
| R-T3 | Pass a per-cycle substrate snapshot (PLAN.md + key context files) from Ego down to Subconscious rather than re-reading from disk. The mtime cache already helps, but explicit sharing removes the ambiguity | medium |
| R-T4 | Keep `evaluateOutcome` defaulting to disabled; when enabled, raise the default quality threshold (currently 70%) to 85% to reduce how often the second call fires | quick win |
| R-T5 | Add a fast-path skip to `HealthCheckScheduler`: if the last N cycles all returned `success` and the log contains no `error`-level entries since the last check, skip the LLM call and emit a synthetic "healthy" result | medium |

---

## 5. Security, Integrity, and Availability

### Current state

**Inbound security:**

| Surface | Auth mechanism | Rate limit | Input validation |
|---|---|---|---|
| HTTP `/api/*` | Optional bearer token | None | Express JSON parser |
| HTTP `/mcp` | None | None | None |
| HTTP `/hooks/agent` | None | None | None |
| WebSocket | Origin check (localhost only by default) | None | None |
| Agora webhook | Ed25519 signature verification | Per-sender sliding window (10/60s default) | Envelope schema |

**Secrets:** `SecretDetector` scans substrate files during `ValidationScheduler` runs. It does not run on every write. Secrets that enter substrate files between validation runs are undetected until the next scheduled scan (weekly by default).

**Permissions:** `permissions.ts` in agents provides a permission matrix. Its enforcement is prompt-level (system prompt includes what is allowed/denied) rather than runtime-enforced at the tool level. Actual filesystem access is only constrained by what the Claude Code CLI allows in the configured working directory.

**Integrity:**
- `FileLock` prevents concurrent writes to the same substrate file.
- `AppendOnlyWriter` enforces append-only access to log files.
- `SubstrateValidator` checks file structure and references on schedule.
- `ReferenceScanner` detects broken `@`-references.
- Agora deduplication: in-memory Set (max 1,000 envelope IDs, oldest-first eviction). Survives only within one process lifetime; a restart clears dedup state, opening a short replay window.

**Availability:**
- Single-process architecture with `supervisor.ts` for restart via exit code 75.
- Graceful shutdown: `orchestrator.stop()` → close WS → close HTTP.
- `shutdownGraceMs` (default 5,000ms) gives active sessions time to finish.
- Sleep state is persisted to substrate so restarts after sleep do not reset the idle counter.
- Rate-limit state is persisted so restarts do not lose backoff timing.
- No multi-instance protection: two processes on the same substrate path would race on `FileLock` and corrupt state.

### Findings

**F-S1 — MCP endpoint has no authentication.** `/mcp` accepts any request. Agents that expose MCP to peers are effectively running an unauthenticated RPC server on their HTTP port. The `invoke` tool on `CodeDispatchMcpServer` can execute arbitrary code with agent permissions.

**F-S2 — `/hooks/agent` has no authentication.** The agent event webhook endpoint accepts any caller. Depending on what hook handlers do, this could be exploited to inject events into the loop.

**F-S3 — Agora replay window on restart.** The in-memory dedup Set (1,000 envelope IDs) is lost on process restart. A short window exists where replayed envelopes from just before shutdown would be accepted. This is a low-severity but real gap.

**F-S4 — SecretDetector runs only on schedule.** Weekly validation means a secret accidentally written to a substrate file could sit there for up to 7 days before detection. There is no write-time scan.

**F-S5 — No multi-instance guard.** Two processes pointed at the same substrate path will race. FileLock helps at the file level but does not prevent double-execution of tasks or duplicate Agora outbound sends.

**F-S6 — Per-sender rate limit state is in-memory only.** A restart resets per-sender counters, allowing a burst of messages immediately after each restart from a sender who would otherwise be throttled.

### Recommendations

| ID | Recommendation | Priority |
|---|---|---|
| R-S1 | Add bearer token requirement to `/mcp` when `apiToken` is configured. If `apiToken` is not set, log a warning that MCP is unauthenticated. Consider disabling `CodeDispatchMcpServer` by default and requiring explicit opt-in | quick win |
| R-S2 | Add bearer token requirement to `/hooks/agent` when `apiToken` is configured, consistent with `/api/*` | quick win |
| R-S3 | Persist the last N processed envelope IDs to a substrate file (e.g. `AGORA_SEEN.md` or a small JSON file) on each write, and reload on startup. 200–500 IDs is sufficient for practical replay protection across restarts | medium |
| R-S4 | Run `SecretDetector` on every substrate file write (in `FileWriter` or as a `DeferredWorkQueue` item) rather than only during weekly validation. Fail the write or emit a high-severity log event on detection | medium |
| R-S5 | Write a PID file to the substrate directory on startup and refuse to start if a PID file already exists for a running process. Remove on clean shutdown | quick win |
| R-S6 | Persist per-sender rate-limit windows (Map entries) to disk on shutdown and reload on startup, consistent with the rate-limit backoff persistence already in place | medium |

---

## 6. Responsiveness

### Current state

**Agora inbound flow:**
```
HTTP POST /agora-webhook
  → verifyEnvelope() (Ed25519)
  → AgoraMessageHandler.processEnvelope()
      → dedup check (in-memory Set)
      → rate limit check
      → unknown sender policy
      → write to CONVERSATION.md
      → IMessageInjector.injectMessage()
           → if session active: inject into running session (fast, <1ms)
           → else: push to pendingMessages[]
      → if not injected: mark [UNPROCESSED] in CONVERSATION.md
```

**Chat / TinyBus flow:**
```
POST /api/conversation/send
  → LoopHttpServer → LoopOrchestrator.handleUserMessage()
      → push to pendingMessages[]
      → if SLEEPING: wake()
      → if STOPPED/PAUSED: no-op
```

**When does the agent actually run?**

In **cycle mode**: `runLoop()` runs on a `NodeTimer` with `cycleDelayMs` (default 30,000ms). After a message arrives:
- If a session is active: message is injected directly into the running session. Response latency = remaining session time + model time.
- If no session: message lands in `pendingMessages[]`. Next cycle fires after up to 30s. The pending message is processed either (a) alongside a dispatched task or (b) via `Ego.respondToMessage()` if idle.
- `timer.wake()` is called on wake/message-with-sleep, which can interrupt the 30s wait. But for normal RUNNING state with an active session, `nudge()` / `timer.wake()` is not called on message injection into `pendingMessages`.

In **tick mode**: messages arrive into the SDK session directly or via `SessionManager`. Responsiveness is better but depends on the session being active.

**Latency sources:**

1. `cycleDelayMs` timer (up to 30s wait before next cycle runs pending messages)
2. Schedulers run before role execution — a slow scheduler (e.g., backup subprocess) can delay the start of the Ego decision by seconds
3. `DeferredWorkQueue.drain()` runs at cycle start — post-cycle work from the previous cycle executes before the new cycle begins
4. In-flight cycle: if a Subconscious session is active when a message arrives, the message waits until that session completes (seconds to minutes)

### Findings

**F-R1 — Messages arriving during an active cycle wait for the whole cycle to finish.** `injectMessage()` already calls `timer.wake()` when no session is active, so idle-wait latency is minimised. However, when `isProcessing = true` (a Subconscious or Ego session is running), the timer is not being awaited and `wake()` has no immediate effect. The message lands in `pendingMessages` and is picked up only after the current LLM session completes, which can take 30–120s.

**F-R2 — Scheduler deferred work drains at cycle start, before role execution.** Schedulers from cycle N are enqueued into `DeferredWorkQueue` and drained at the beginning of cycle N+1, before Ego runs. A slow scheduler (backup subprocess, network health check) delays the current cycle's first useful work (Ego decision) by however long it takes.

**F-R3 — Schedulers are not interruptible by pending messages.** If a Backup or Health scheduler fires in the same drain-phase as a pending external message, the message waits for the scheduler to finish. There is no "pending messages → skip non-urgent scheduler" fast path.

**F-R4 — No sender-visible acknowledgement of injection status.** When an Agora message is accepted and injected (or queued), the HTTP response is `200 OK` with no structured body. The sender cannot distinguish "injected into active session" from "queued for next cycle" from "marked UNPROCESSED (no session)".

### Recommendations

| ID | Recommendation | Priority |
|---|---|---|
| R-R1 | Document the in-cycle latency clearly: when a long Subconscious session is running, incoming messages wait. As a mitigation, consider a maximum Subconscious session wall-time (already exists as `conversationSessionMaxDurationMs`); ensure it applies to cycle-mode sessions too and is tuned to a value that balances work throughput vs. responsiveness | quick win |
| R-R2 | Move `DeferredWorkQueue.drain()` to end-of-cycle (after role execution). Deferred work from cycle N runs at the end of N, freeing cycle N+1's start for immediate Ego dispatch. This is the natural place: "do cleanup after the main work, not before the next cycle's main work" | medium |
| R-R3 | In `SchedulerCoordinator.runDueSchedulers()`, check `pendingMessages.length > 0` before running non-urgent schedulers (Metrics, Validation, Health). If messages are waiting, defer those schedulers one cycle | medium |
| R-R4 | Return a structured JSON body from the Agora webhook response: `{ accepted: true, status: "injected" \| "queued" \| "unprocessed" }`. This lets senders know whether the agent is currently active | quick win |

---

## 7. Frugal Process Usage

### Current state

**Process spawn points:**

| Spawn point | Mechanism | Lifecycle |
|---|---|---|
| Agent sessions (Ego, Subconscious, Superego, Id) | `AgentSdkLauncher` → Claude Agent SDK | Started per-session; idle timeout kills after inactivity; `ProcessTracker` + `NodeProcessKiller` for cleanup |
| Code dispatch (Claude CLI) | `ClaudeCliBackend` → `NodeProcessRunner` → `child_process.spawn` | New process per `invoke` call |
| Code dispatch (Gemini CLI) | `GeminiCliBackend` → `NodeProcessRunner` → `child_process.spawn` | New process per `invoke` call |
| Backup | `BackupScheduler` → `IProcessRunner` → shell command | New process per backup run |
| Vertex AI fallback | `VertexSessionLauncher` → `NodeProcessRunner` | New process per session (subprocess fallback when SDK unavailable) |

**Session reuse:** In cycle mode, `AgentSdkLauncher` starts a new Claude Code session for each task dispatch (Subconscious) and each role invocation (Ego, Superego, Id). Sessions are not reused across cycles. The `conversationIdleTimeoutMs` (default 20s) and `conversationSessionMaxDurationMs` (default 5min) govern when a session is considered dead.

**Cycle vs. tick:** Tick mode uses `SessionManager` to maintain a persistent SDK session across multiple user messages, which is significantly more frugal than cycle mode for conversation-heavy workloads.

**Scheduler-triggered sessions:** `HealthCheckScheduler` triggers an LLM call (potentially a new session). `MetricsScheduler` may invoke LLM summarisation. Each of these can add a session to whatever is already running.

**R2 ceiling:** The loop halts at 50 successful cycles per session (configurable). This prevents runaway dispatch but also means the process must be restarted (supervisor) to continue work, adding restart overhead.

### Findings

**F-P1 — Code dispatch starts a new subprocess per invocation.** `ClaudeCliBackend` runs `claude --print -p "<prompt>"` as a new process for every code execution request. For frequent short dispatch operations this is expensive. The same applies to `GeminiCliBackend`.

**F-P2 — Cycle mode starts a new agent session per cycle.** Each Ego decision and each Subconscious task execution is a new Claude Code session. For a system running 30s cycles with active tasks, this is one or more new processes per 30s.

**F-P3 — All 6 schedulers check `shouldRun()` every cycle.** Even disabled schedulers are checked. The check is cheap but the unconditional instantiation of all scheduler objects (including their dependencies) wastes memory.

**F-P4 — HealthCheckScheduler and MetricsScheduler may both invoke LLM calls in the same cycle.** There is no coalescing: if both fire in the same `SchedulerCoordinator.runDue()` pass, two LLM sessions start back-to-back in the same cycle (on top of the regular Ego/Subconscious sessions).

### Recommendations

| ID | Recommendation | Priority |
|---|---|---|
| R-P1 | For `ClaudeCliBackend` and `GeminiCliBackend`, evaluate whether the CLI supports a "server" or "batch" mode that can handle multiple prompts in one process invocation. If not, document the per-call spawn cost and consider rate-limiting code dispatch requests | medium |
| R-P2 | Document that tick mode is the recommended choice for any workload with frequent external messages. Prefer tick mode as the default in documentation; cycle mode is appropriate for fully autonomous batch work | quick win |
| R-P3 | Only instantiate schedulers that are config-enabled. Gating instantiation on config in `createLoopLayer.ts` removes unnecessary object allocation and makes the active feature set transparent | quick win |
| R-P4 | Add a "one LLM-session-per-cycle" coalescing constraint to `SchedulerCoordinator`: if the current cycle already invoked an LLM session (detected via a flag set by the orchestrator), defer any scheduler-triggered LLM calls to the next cycle | medium |

---

## 8. Cross-Cutting Concerns

### Priorities summary

| ID | Theme | Priority | Dependencies |
|---|---|---|---|
| R-L1 | Extract sub-methods from executeOneCycle | quick win | — |
| R-L3, R-P3 | Guard optional-feature instantiation | quick win | — |
| R-S1, R-S2 | Auth for `/mcp` and `/hooks/agent` | quick win | — |
| R-S5 | PID file guard | quick win | — |
| R-R1 | Tune session wall-time cap in cycle mode (document in-cycle latency) | quick win | — |
| R-T4 | Raise evaluateOutcome threshold | quick win | — |
| R-T2 | Cap eager @-references, surface in validation | quick win | SubstrateValidator |
| R-R4 | Structured Agora webhook response | quick win | — |
| R-L4 | PeriodicJobScheduler consolidation | medium | R-L3, R-P3 |
| R-L5 | Remove or demote INS hook | medium | — |
| R-T1 | Conversation window cap in prompt builder | medium | ConversationCompactor |
| R-T3 | Within-cycle substrate snapshot sharing | medium | — |
| R-T5 | HealthCheck fast-path skip | medium | — |
| R-S3 | Persist envelope dedup IDs | medium | — |
| R-S4 | Write-time secret detection | medium | FileWriter |
| R-S6 | Persist per-sender rate-limit state | medium | — |
| R-R2 | Move DeferredWork drain to end-of-cycle | medium | — |
| R-R3 | Interruptible schedulers when messages pending | medium | — |
| R-P4 | One-LLM-session-per-cycle coalescing | medium | SchedulerCoordinator |
| R-L2 | Split createLoopLayer into sub-factories | refactor | R-L3, R-L4 |
| R-P1 | Evaluate CLI batch mode for code dispatch | refactor | — |

### Design invariants to preserve

- **Inspection guarantee:** Total codebase stays readable in one context window. The quick wins and medium changes must not add net LOC. R-L2, R-L4, and R-L5 should reduce LOC.
- **Fork-first:** No shared mutable state between agent instances. PID file guard (R-S5) enforces this at the file system level.
- **Agora as dumb pipe:** Agora relay passes envelopes through; substrate handles trust, dedup, and rate limiting. R-S3 and R-S6 add persistence without making Agora stateful.
- **No secrets in substrate:** R-S4 makes this constraint enforced at write time rather than only on a weekly scan.
- **File-based substrate:** All changes remain compatible with human-readable, version-controllable plain-markdown state.

### Configuration

Changes that should be configurable (and where config lives — `server/src/config.ts` / `ApplicationConfig`):

| Behaviour | Config key (new or existing) |
|---|---|
| Conversation prompt window cap | `conversationPromptWindowLines` (new) |
| Max eager @-references per file | Validated in SubstrateValidator; not a runtime config |
| HealthCheck fast-path skip threshold | `healthCheck.noErrorWindowCycles` (new) |
| MCP auth required | Derived from existing `apiToken` |
| Envelope dedup persistence path | Derived from `substratePath` |
| Scheduler LLM coalescing | `schedulerCoalesceEnabled` (new, default true) |

### Testing and observability

To verify this review's goals are met, add or extend:

- **Token cost per cycle:** log `prompt_tokens` + `completion_tokens` from each SDK session response; expose as metric in `GET /api/metrics`. Target: track trend over time.
- **Inbound message → first agent step latency:** log timestamp when message enters `pendingMessages` and when it is first consumed by Ego or Subconscious. Expose P50/P95 in metrics. Target: ≤ 1 cycle delay (≤30s in cycle mode, ≤2s in tick mode).
- **Process spawns per hour:** extend `PerformanceMetrics` to count `NodeProcessRunner.run()` calls. Expose in metrics.
- **Active scheduler list:** expose which schedulers are instantiated and their last-run timestamp in `GET /api/health`.
- **Dedup Set size:** expose in `GET /api/health` or metrics to monitor eviction pressure.

---

## 9. References

| Area | Key files |
|---|---|
| Wiring | `server/src/loop/createLoopLayer.ts`, `createAgentLayer.ts`, `createSubstrateLayer.ts`, `createApplication.ts` |
| Main loop | `server/src/loop/LoopOrchestrator.ts`, `types.ts`, `IdleHandler.ts`, `DeferredWorkQueue.ts` |
| HTTP/WS | `server/src/loop/LoopHttpServer.ts`, `LoopWebSocketServer.ts` |
| Schedulers | `server/src/loop/{Backup,Email,Health,Heartbeat,Metrics,Validation}Scheduler.ts`, `SchedulerCoordinator.ts` |
| Cognitive roles | `server/src/agents/roles/{Ego,Subconscious,Superego,Id}.ts` |
| Prompts | `server/src/agents/prompts/PromptBuilder.ts`, `server/src/session/TickPromptBuilder.ts` |
| Agora | `server/src/agora/AgoraMessageHandler.ts`, `AgoraOutboundProvider.ts` |
| TinyBus | `server/src/tinybus/TinyBus.ts`, `providers/` |
| Substrate I/O | `server/src/substrate/io/{FileReader,FileWriter,FileLock,AppendOnlyWriter}.ts` |
| Validation | `server/src/substrate/validation/{SecretDetector,SubstrateValidator,ReferenceScanner}.ts` |
| Config | `server/src/config.ts` |
| INS | `server/src/loop/ins/{INSHook,ComplianceStateManager,types}.ts` |
| Code dispatch | `server/src/code-dispatch/{CodeDispatcher,ClaudeCliBackend,GeminiCliBackend}.ts` |
| Sessions | `server/src/session/SessionManager.ts`, `server/src/agents/claude/AgentSdkLauncher.ts` |

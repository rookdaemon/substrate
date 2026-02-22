# Architectural Review — Specification & Plan

This document defines **requirements and scope** for producing `ARCHITECTURAL_REVIEW.md`. It is the plan for what the review must cover and how to conduct it, aligned with five goals: **leaner code**, **token efficiency**, **security/integrity/availability**, **responsiveness**, and **frugal process usage**.

---

## 1. Purpose of ARCHITECTURAL_REVIEW.md

The final `ARCHITECTURAL_REVIEW.md` shall:

- **Diagnose** current complexity, cost, security, latency, and process-spawn behavior.
- **Prescribe** concrete, prioritized changes (with trade-offs) to improve each dimension.
- **Remain actionable**: each section should point to specific modules, config, or code areas and suggest measurable outcomes (e.g. “reduce createApplication dependencies by X”, “inbound message → first token in &lt; Y ms”).

This spec does **not** require the review to implement changes; it defines what the review document must specify so that implementation can follow in later work.

---

## 2. Themes and Requirements

### 2.1 Leaner code

**Goal:** Less code surface, fewer moving parts, easier to read and change.

**Requirements for ARCHITECTURAL_REVIEW.md:**

- **Inventory and categorize**
  - List all major subsystems (substrate I/O, agents, loop, evaluation, conversation, Agora, TinyBus, schedulers, MCP, client).
  - For each: approximate size (files/LoC), number of dependencies it takes in, and whether it is essential to “one agent loop + external comms” or optional (e.g. metrics, backups, email, validation).
- **Identify duplication and overlap**
  - Multiple schedulers (backup, health, email, metrics, validation) and their shared pattern vs. a single “scheduled job” abstraction.
  - Overlap between conversation handling (ConversationManager, ConversationArchiver, ConversationCompactor, ConversationProvider) and Agora/UNPROCESSED flow.
  - TinyBus providers (loopback, session-injection, chat-handler, conversation, Agora outbound) and whether all are necessary or can be consolidated.
- **Propose simplification**
  - Optional vs. default-on: which features should be opt-in to reduce default complexity (e.g. metrics, validation, email, health checks).
  - Consolidation: e.g. one scheduler + job types vs. five scheduler classes; one “external message intake” path instead of separate Agora + chat + session-injection entry points where possible.
  - Dead or rarely used code: criteria and process for identifying and removing it.
- **Inspection guarantee**
  - Preserve “codebase fits in context / readable by agent” where possible; call out any new or existing hotspots that violate this.

**Relevant code areas (for the review to reference):**

- `server/src/loop/createApplication.ts` (wiring and dependency count).
- `server/src/loop/LoopOrchestrator.ts` (state and scheduler hooks).
- All `*Scheduler.ts`, `evaluation/*`, `conversation/*`, `agora/*`, `tinybus/*`.

---

### 2.2 Token efficiency

**Goal:** Lower token cost per cycle/tick and per external interaction; avoid unnecessary LLM calls.

**Requirements for ARCHITECTURAL_REVIEW.md:**

- **Map token-bearing operations**
  - Ego, Subconscious, Superego, Id: when each is invoked, what prompts they get, and what drives size (substrate files, CONVERSATION.md, PROGRESS.md, context caps).
  - Conversation compaction, archiving, and any “summarize for tokens” steps.
  - One-off or scheduled flows that call the model: health check, plan quality, reasoning validation, metrics, validation scheduler, email digest, etc.
- **Identify waste**
  - Redundant reads of the same substrate files across roles or in the same cycle.
  - Oversized prompts (e.g. full CONVERSATION vs. sliding window or summary).
  - Scheduled jobs that run regardless of need (e.g. validation every 7 days vs. on-demand or on-change).
  - Multiple model calls that could be batched or replaced with heuristics.
- **Propose levers**
  - Prompt design: caps, summaries, two-tier (index + on-demand detail) consistency.
  - Caching: what can be cached per cycle or per run to avoid re-reading.
  - Feature flags: disable or lengthen intervals for expensive optional jobs (metrics, validation, health, email).
  - Idle/sleep: how sleep and wake affect token burn and whether they are sufficient.

**Relevant code areas:**

- `server/src/agents/` (Ego, Subconscious, Superego, Id; PromptBuilder; TaskClassifier).
- `server/src/conversation/` (ConversationCompactor, ConversationArchiver, ConversationManager).
- `server/src/evaluation/` (HealthCheck, PlanQualityEvaluator, MetricsScheduler, ValidationScheduler, etc.).
- `server/src/loop/` (cycle vs. tick; when each role runs).

---

### 2.3 Security, integrity, and availability

**Goal:** Stronger security, data integrity, and availability without adding unnecessary complexity.

**Requirements for ARCHITECTURAL_REVIEW.md:**

- **Security**
  - **Inbound:** Agora (relay + direct), TinyBus/MCP, HTTP/WS (chat, API). For each: auth (e.g. JWT, Bearer), rate limits, input validation, and trust boundaries.
  - **Secrets:** Substrate validation (SecretDetector), redaction, and where secrets might still leak (logs, errors, prompts).
  - **Permissions:** PermissionChecker and file/system actions; clarity of allow/deny and audit trail.
- **Integrity**
  - Substrate files: locking (FileLock), append-only writer, validation (SubstrateValidator, ReferenceScanner).
  - Backups: verification, retention, and restore path.
  - Conversation and Agora: UNPROCESSED marking, deduplication (envelope ID), and replay/ordering guarantees.
- **Availability**
  - Single process vs. multi-instance: what breaks if two processes run (e.g. file locks, Agora relay).
  - Graceful shutdown: orchestrator stop, resource cleanup, in-flight request handling.
  - Restart and recovery: startup scan for UNPROCESSED, sleep state persistence, rate-limit state.
- **Align with existing security docs**
  - Reference relay security notes in the [agora](https://github.com/rookdaemon/agora) repo and any substrate-specific assumptions.

**Relevant code areas:**

- `server/src/agora/AgoraMessageHandler.ts` (dedup, rate limit, unknown sender, verification).
- `server/src/substrate/validation/SecretDetector.ts`, `server/src/substrate/io/FileLock.ts`, `server/src/substrate/initialization/SubstrateValidator.ts`.
- `server/src/loop/LoopHttpServer.ts` (auth, routes).
- `server/src/loop/createApplication.ts` (shutdown, cleanup).
- `server/src/agora-relay/` (in-process relay using [agora](https://github.com/rookdaemon/agora)); relay implementation and REST API live in the agora repo.

---

### 2.4 Responsiveness to external communication

**Goal:** Inbound messages (Agora, chat, TinyBus, MCP) get a visible or actionable response as soon as possible.

**Requirements for ARCHITECTURAL_REVIEW.md:**

- **Describe current flow**
  - Agora: message received → verify → CONVERSATION.md + inject (or queue) → when does the agent actually run?
  - Chat / TinyBus: `handleUserMessage` / provider → inject or conversation session → when does the loop/tick run?
  - Tick vs. cycle mode: how does “inject” translate into “next tick” or “next cycle” and what delays exist (e.g. cycleDelayMs, waiting for current cycle to finish).
- **Identify latency sources**
  - Queueing: pendingMessages, conversation queue, UNPROCESSED backlog.
  - Scheduling: loop runs on a timer; no dedicated “wake on message” path that starts work immediately.
  - Blocking: long-running Superego audit or health check delaying the next Ego cycle.
- **Propose improvements**
  - Immediate wake: on inject, ensure loop/tick is running (or start it) and consider “interrupt” or “priority” lane for external messages.
  - Bounded wait: target “message received → first agent step for that message within X ms” and what changes are needed (e.g. event-driven tick, smaller cycle delay when messages pending).
  - Visibility: how the frontend or sender can know the message was accepted and when the agent began processing (e.g. events, status endpoints).

**Relevant code areas:**

- `server/src/agora/AgoraMessageHandler.ts` (inject, wakeLoop).
- `server/src/loop/LoopOrchestrator.ts` (injectMessage, handleUserMessage, pendingMessages, runLoop, runTickLoop, wake).
- `server/src/loop/IdleHandler.ts`, cycle delay and tick scheduling.
- `server/src/loop/LoopWebSocketServer.ts` (events to client).

---

### 2.5 Frugal process initiation

**Goal:** Start fewer processes, less often; reuse or share where safe.

**Requirements for ARCHITECTURAL_REVIEW.md:**

- **Inventory process spawn points**
  - Agent SDK launcher (Claude Code sessions): when are they started, how long do they live, when are they killed (idle timeout, abandoned process grace, reaper).
  - Backup: subprocess or CLI for backup/restore.
  - Any other child processes (e.g. email, external scripts).
- **Identify unnecessary or overlapping runs**
  - Multiple scheduler-driven jobs that each might start a session or process (e.g. health check, metrics, validation each triggering model or external calls).
  - Cycle vs. tick: whether both modes are needed and how they affect process count.
  - Reaper and grace periods: risk of killing useful work vs. leaving zombies.
- **Propose levers**
  - Coalescing: run several “scheduled” tasks in one agent cycle or one batch instead of separate triggers.
  - Longer intervals or on-demand: e.g. validation only on deploy or on file change; metrics less frequent.
  - Session reuse: when a session can serve multiple messages (e.g. conversation session) vs. when a new process is required.
  - Clear policy: when to spawn, when to queue, when to skip (e.g. rate limit, sleep, already busy).

**Relevant code areas:**

- `server/src/agents/claude/AgentSdkLauncher.ts`, `NodeProcessRunner.ts`, `ProcessTracker.ts`.
- `server/src/loop/BackupScheduler.ts` (runner usage).
- All schedulers in `server/src/loop/*Scheduler.ts`.
- `server/src/loop/LoopOrchestrator.ts` (runLoop, runTickLoop, idle/sleep).

---

## 3. Cross-cutting requirements

The review document must also:

- **Prioritize:** For each theme, label recommendations as “quick win”, “medium effort”, or “larger refactor”, and call out dependencies between themes (e.g. fewer schedulers → leaner code and more frugal process use).
- **Preserve invariants:** Call out design constraints that must hold (e.g. inspection guarantee, fork-first, Agora as dumb pipe, no secrets in substrate).
- **Config and env:** Note which behaviors should be configurable (e.g. cycle delay, which schedulers are on, token-related caps) and where config lives.
- **Testing and observability:** What tests or metrics would verify that the review’s goals are met (e.g. “inbound message → first token” latency, token count per cycle, number of process spawns per hour).

---

## 4. Plan for producing ARCHITECTURAL_REVIEW.md

1. **Gather**
   - Walk codebase per section (createApplication, orchestrator, agents, evaluation, conversation, Agora, TinyBus, schedulers).
   - Extract config surface (config.ts, ApplicationConfig, env) and document defaults.
   - List all entry points for “external world” (HTTP, WS, Agora relay, MCP, file watcher).

2. **Analyze**
   - For “leaner”: count dependencies per module; list optional features and their call sites.
   - For “tokens”: trace every place that builds a prompt or calls the model; estimate relative cost of each.
   - For “security/integrity/availability”: checklist against the requirements above; reference existing SECURITY.md.
   - For “responsiveness”: trace one Agora and one chat message end-to-end; note all delays.
   - For “frugal”: list every spawn/exec and under what condition.

3. **Write ARCHITECTURAL_REVIEW.md**
   - One section per theme (plus intro and cross-cutting).
   - Each section: current state, findings, recommended changes with priority and trade-offs.
   - Point to files and line ranges where useful; add a short “References” list of key paths.

4. **Review and iterate**
   - Optional: lightweight review with maintainers to ensure recommendations are feasible and aligned with roadmap.
   - Version the document (e.g. in repo or doc title) so later implementation can refer to it.

---

## 5. Document structure for ARCHITECTURAL_REVIEW.md (suggested outline)

- **1. Introduction** — Scope, goals (five themes), and how to read the doc.
- **2. Current architecture (summary)** — High-level diagram or list of subsystems and data flow; main entry points.
- **3. Leaner code** — Inventory, duplication, optionality, consolidation, inspection guarantee.
- **4. Token efficiency** — Token-bearing operations, waste, levers (prompts, cache, flags, idle).
- **5. Security, integrity, and availability** — Inbound security, secrets, integrity, availability, references to Agora SECURITY.md.
- **6. Responsiveness** — Current flow, latency sources, improvements (wake, bounded wait, visibility).
- **7. Frugal process usage** — Spawn points, overlapping runs, levers (coalesce, intervals, reuse, policy).
- **8. Cross-cutting** — Priorities, invariants, config, testing/observability.
- **9. References** — Key files and config locations.

---

## 6. Success criteria for the review

The ARCHITECTURAL_REVIEW.md specification is satisfied when:

- All five themes are covered with “current state”, “findings”, and “recommendations”.
- Each recommendation is traceable to code or config (file/area).
- Priorities and trade-offs are stated so that implementation can be scheduled.
- The document is self-contained enough for a new contributor or an agent to understand what to change and why, without requiring this spec doc open alongside it.

This spec can be updated if new themes or constraints emerge; the actual review document should then be updated to match.

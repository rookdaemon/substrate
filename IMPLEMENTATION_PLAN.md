# IMPLEMENTATION_PLAN.md

## Self-Referential Agent Shell (Ralph Wiggum REPL) - v1

This document outlines the phased implementation plan for building a persistent, self-referential orchestration layer around Claude Code with distinct cognitive roles, file-based memory, and autonomous goal-setting capabilities.

---

## Overview

The system consists of:
- **Backend**: Node.js + TypeScript runtime with execution loop
- **Frontend**: React + Vite for conversation and state monitoring
- **Cognitive Substrate**: Markdown files for memory, identity, and planning
- **Agent Roles**: Ego (planner), Subconscious (worker), Superego (auditor), Id (motivation)

**Run Commands**:
- `npm run client:dev` - Start frontend development server
- `npm run server:dev` - Start backend execution loop

---

## Phase 1: Project Foundation & Infrastructure

**Goal**: Establish the technical foundation for both backend and frontend with proper tooling.

### 1.1 Node.js/TypeScript Project Setup
- **1.1.1** Initialize root package.json with workspace configuration
- **1.1.2** Create `server/` directory for backend
- **1.1.3** Create `client/` directory for frontend
- **1.1.4** Configure TypeScript for both workspaces
- **1.1.5** Set up ESLint and Prettier for code quality
- **1.1.6** Configure Jest for unit testing (backend)
- **1.1.7** Configure Vitest for unit testing (frontend)

**Dependencies**: None (foundation phase)

**Completion Criteria**: `npm install`, `npm run lint`, and `npm test` work in both workspaces

---

## Phase 2: Core File Substrate System

**Goal**: Implement the file-based cognitive substrate that serves as the system's persistent memory and identity.

### 2.1 Substrate File Structure
*Depends on: 1.1.x completed*

- **2.1.1** Create `substrate/` directory for markdown files
- **2.1.2** Define TypeScript interfaces for all substrate files (PLAN, MEMORY, HABITS, etc.)
- **2.1.3** Implement substrate file path configuration module

### 2.2 Substrate File Managers
*Can be done in parallel with 2.3*

- **2.2.1** Implement `FileReader` utility for reading substrate files
- **2.2.2** Implement `FileWriter` utility for writing substrate files (with validation)
- **2.2.3** Implement `AppendOnlyWriter` for PROGRESS.md
- **2.2.4** Add file locking mechanism to prevent concurrent write conflicts

### 2.3 Substrate File Templates
*Can be done in parallel with 2.2*

- **2.3.1** Create template for MEMORY.md (long-term facts)
- **2.3.2** Create template for HABITS.md (behavioral defaults)
- **2.3.3** Create template for SKILLS.md (learned capabilities)
- **2.3.4** Create template for VALUES.md (optimization targets)
- **2.3.5** Create template for ID.md (motivational drives)
- **2.3.6** Create template for SECURITY.md (security policies)
- **2.3.7** Create template for CHARTER.md (operational doctrine)
- **2.3.8** Create template for SUPEREGO.md (evaluation criteria)
- **2.3.9** Create template for CLAUDE.md (Claude Code capabilities model)
- **2.3.10** Create template for PLAN.md (task tree structure)
- **2.3.11** Create template for PROGRESS.md (execution log)
- **2.3.12** Create template for CONVERSATION.md (user transcript)

### 2.4 Substrate Initialization
*Depends on: 2.1.x, 2.2.x, 2.3.x completed*

- **2.4.1** Implement initialization script to create substrate files from templates
- **2.4.2** Add validation for required substrate files on system startup
- **2.4.3** Implement backup/versioning strategy for substrate files

**Completion Criteria**: All substrate files can be created, read, written, and validated programmatically

---

## Phase 3: Agent Roles & Claude Integration

**Goal**: Define agent role system and integrate with Claude Code for task execution.

### 3.1 Role Definition System
*Depends on: 2.1.x completed*

- **3.1.1** Define TypeScript enums/types for agent roles (Ego, Subconscious, Superego, Id)
- **3.1.2** Implement permission matrix for file access by role
- **3.1.3** Create role-specific system prompt templates

### 3.2 Ego (Executive Layer) Implementation
*Depends on: 3.1.x completed*

- **3.2.1** Implement Ego class with planning capabilities
- **3.2.2** Implement PLAN.md reader/parser for Ego
- **3.2.3** Implement PLAN.md writer/updater for Ego
- **3.2.4** Implement CONVERSATION.md append logic for Ego
- **3.2.5** Implement next action decision logic for Ego
- **3.2.6** Implement Subconscious task dispatcher from Ego

### 3.3 Subconscious (Worker Layer) Implementation
*Depends on: 3.1.x completed*

- **3.3.1** Implement Subconscious class for task execution
- **3.3.2** Implement PROGRESS.md writer for Subconscious
- **3.3.3** Implement PLAN.md task completion marker for Subconscious
- **3.3.4** Implement SKILLS.md append-only updater for Subconscious
- **3.3.5** Implement proposal generator for MEMORY/HABITS/SECURITY updates

### 3.4 Superego (Governance Layer) Implementation
*Depends on: 3.1.x completed*

- **3.4.1** Implement Superego class for auditing
- **3.4.2** Implement drift detection analyzer
- **3.4.3** Implement security posture reviewer
- **3.4.4** Implement inconsistency detector
- **3.4.5** Implement governance report generator
- **3.4.6** Implement proposal evaluator

### 3.5 Id (Motivation Layer) Implementation
*Depends on: 3.1.x completed*

- **3.5.1** Implement Id class for drive generation
- **3.5.2** Implement ID.md reader
- **3.5.3** Implement goal candidate generator
- **3.5.4** Implement idle condition detector

### 3.6 Claude Code Integration
*Depends on: 3.1.x completed*

- **3.6.1** Research Claude Code API/CLI integration options
- **3.6.2** Implement Claude Code session launcher
- **3.6.3** Implement role-specific prompt injection system
- **3.6.4** Implement session output capture and parsing
- **3.6.5** Implement error handling and retry logic for Claude sessions

**Completion Criteria**: All agent roles can be instantiated, have proper permissions, and can trigger Claude Code sessions

---

## Phase 4: Runtime Loop & Execution Engine

**Goal**: Build the core REPL that continuously executes plans and coordinates agents.

### 4.1 Core Loop Infrastructure
*Depends on: 2.4.x, 3.2.x, 3.3.x completed*

- **4.1.1** Implement main loop orchestrator class
- **4.1.2** Implement loop state management (running, paused, stopped)
- **4.1.3** Implement cycle counter and timing metrics
- **4.1.4** Implement graceful shutdown handler

### 4.2 Plan Execution Logic
*Depends on: 4.1.x completed*

- **4.2.1** Implement PLAN.md parser to extract actionable tasks
- **4.2.2** Implement task prioritization and selection logic (smallest actionable step)
- **4.2.3** Implement task dispatch to Subconscious
- **4.2.4** Implement task completion verification
- **4.2.5** Implement PROGRESS.md logging after each task

### 4.3 Loop Control API
*Depends on: 4.1.x completed*

- **4.3.1** Implement REST API for loop control (start, pause, stop)
- **4.3.2** Implement WebSocket server for real-time status updates
- **4.3.3** Implement status endpoint for current loop state
- **4.3.4** Implement metrics endpoint for cycle statistics

**Completion Criteria**: Backend loop runs continuously, executes tasks from PLAN.md, and logs to PROGRESS.md

---

## Phase 5: Frontend Interface

**Goal**: Create a React-based UI for monitoring conversation state and interacting with the system.

### 5.1 Frontend Project Setup
*Depends on: 1.1.x completed*

- **5.1.1** Initialize Vite + React + TypeScript in `client/` directory
- **5.1.2** Configure TailwindCSS or preferred styling solution
- **5.1.3** Set up React Router for navigation
- **5.1.4** Configure WebSocket client for backend connection

### 5.2 Core UI Components
*Depends on: 5.1.x completed*

- **5.2.1** Implement ConversationView component (displays CONVERSATION.md)
- **5.2.2** Implement InputField component for user messages
- **5.2.3** Implement PlanView component (displays current PLAN.md)
- **5.2.4** Implement ProgressLog component (displays recent PROGRESS.md entries)
- **5.2.5** Implement SystemStatus component (loop state, cycle count, etc.)

### 5.3 User Interaction Features
*Depends on: 5.2.x, 4.3.x completed*

- **5.3.1** Implement message sending to Ego via API
- **5.3.2** Implement real-time conversation updates via WebSocket
- **5.3.3** Implement loop control buttons (pause, resume, stop)
- **5.3.4** Implement substrate file viewer (read-only access to MEMORY, HABITS, etc.)

### 5.4 Advanced UI Features
*Depends on: 5.3.x completed*

- **5.4.1** Implement task tree visualization for PLAN.md
- **5.4.2** Implement progress timeline view
- **5.4.3** Implement system health indicators
- **5.4.4** Implement notification system for important events

**Completion Criteria**: Frontend runs with `npm run client:dev`, connects to backend, displays conversation and plan state

---

## Phase 6: Idle Behavior & Id Activation

**Goal**: Enable autonomous goal generation when the system has no active tasks.

### 6.1 Idle Detection
*Depends on: 4.2.x, 3.5.x completed*

- **6.1.1** Implement PLAN.md empty detector
- **6.1.2** Implement PLAN.md completion detector
- **6.1.3** Implement staleness timer (no activity for N cycles)
- **6.1.4** Implement idle condition aggregator

### 6.2 Goal Generation Pipeline
*Depends on: 6.1.x completed*

- **6.2.1** Implement ID.md-driven goal candidate generator (via Id agent)
- **6.2.2** Implement goal template system
- **6.2.3** Implement goal priority scorer
- **6.2.4** Implement Superego risk evaluation for generated goals

### 6.3 Autonomous Plan Creation
*Depends on: 6.2.x completed*

- **6.3.1** Implement automatic PLAN.md generation from approved goals
- **6.3.2** Implement goal breakdown into actionable tasks
- **6.3.3** Implement automatic loop resume after plan creation
- **6.3.4** Add logging of autonomous goal generation to PROGRESS.md

**Completion Criteria**: System generates new plans when idle and continues execution autonomously

---

## Phase 7: Superego Evaluation System

**Goal**: Implement periodic governance and drift detection capabilities.

### 7.1 Evaluation Scheduling
*Depends on: 4.1.x, 3.4.x completed*

- **7.1.1** Implement periodic evaluation trigger (every N cycles)
- **7.1.2** Implement event-based evaluation trigger (after major PLAN change)
- **7.1.3** Implement user-requested evaluation trigger
- **7.1.4** Implement evaluation priority queue

### 7.2 Analysis Modules
*Depends on: 7.1.x completed*

- **7.2.1** Implement drift analyzer (compare current state vs. initial templates)
- **7.2.2** Implement consistency checker (cross-reference substrate files)
- **7.2.3** Implement security posture analyzer (review SECURITY.md compliance)
- **7.2.4** Implement plan quality evaluator
- **7.2.5** Implement reasoning validator (check logical coherence)

### 7.3 Reporting & Alerts
*Depends on: 7.2.x completed*

- **7.3.1** Implement governance report formatter
- **7.3.2** Implement drift warning system (thresholds and alerts)
- **7.3.3** Implement risk scoring system
- **7.3.4** Implement report storage in substrate/reports/ directory
- **7.3.5** Implement frontend display for latest governance report

**Completion Criteria**: Superego runs periodically, generates reports, and flags potential issues without modifying files

---

## Phase 8: Testing & Documentation

**Goal**: Ensure system reliability and provide comprehensive documentation.

### 8.1 Backend Unit Tests
*Can be done in parallel with 8.2*

- **8.1.1** Write tests for FileReader/FileWriter utilities
- **8.1.2** Write tests for each agent role (Ego, Subconscious, Superego, Id)
- **8.1.3** Write tests for core loop logic
- **8.1.4** Write tests for idle detection
- **8.1.5** Write tests for evaluation system
- **8.1.6** Achieve >80% code coverage for critical paths

### 8.2 Frontend Unit Tests
*Can be done in parallel with 8.1*

- **8.2.1** Write tests for core UI components
- **8.2.2** Write tests for WebSocket integration
- **8.2.3** Write tests for API integration
- **8.2.4** Write tests for user interaction flows

### 8.3 Integration Tests
*Depends on: 8.1.x, 8.2.x completed*

- **8.3.1** Write end-to-end test for full task execution cycle
- **8.3.2** Write test for idle → goal generation → execution flow
- **8.3.3** Write test for Superego evaluation trigger
- **8.3.4** Write test for user interaction via frontend

### 8.4 Documentation
*Depends on: All previous phases completed*

- **8.4.1** Write comprehensive README.md with setup instructions
- **8.4.2** Document all substrate file formats and purposes
- **8.4.3** Document agent role responsibilities and permissions
- **8.4.4** Write developer guide for extending the system
- **8.4.5** Write user guide for interacting with the system
- **8.4.6** Document Claude Code integration patterns
- **8.4.7** Create architecture diagrams (system overview, data flow, agent interactions)
- **8.4.8** Write troubleshooting guide

### 8.5 System Validation
*Depends on: 8.4.x completed*

- **8.5.1** Perform manual end-to-end validation of full system
- **8.5.2** Verify all success criteria from specification
- **8.5.3** Verify system runs continuously without crashes
- **8.5.4** Verify autonomous behavior (goal generation and execution)
- **8.5.5** Verify Superego produces governance reports
- **8.5.6** Verify substrate files evolve correctly over time

**Completion Criteria**: All tests pass, documentation is complete, system meets all v1 success criteria

---

## Non-Goals (v1)

The following are explicitly **excluded** from v1 to maintain simplicity and inspectability:

- ❌ Long-lived autonomous background daemons
- ❌ Complex memory vector databases
- ❌ Self-modifying CHARTER.md
- ❌ Automatic SECURITY.md rewrites
- ❌ Multi-agent concurrency (parallel worker execution)
- ❌ Conflict arbitration between Id/Ego/Superego
- ❌ Identity drift visualization UI
- ❌ Governance scoring metrics
- ❌ Plan quality metrics dashboard
- ❌ Self-refactoring of CHARTER

These features may be considered for future versions.

---

## Success Criteria

The v1 system is considered **complete and functional** when:

✅ It keeps acting without user prompting (autonomous execution)  
✅ It completes PLANs iteratively (task-by-task progress)  
✅ It generates new PLANs when idle (self-directing behavior)  
✅ It logs PROGRESS consistently (append-only execution log)  
✅ It evolves SKILLS/MEMORY over time (learning and adaptation)  
✅ It questions itself periodically (Superego governance)  
✅ Frontend displays current conversation state and accepts user input  
✅ System can run continuously with `npm run server:dev` and `npm run client:dev`

---

## Dependency Summary

### Critical Path
1. Phase 1 (Foundation) → Everything else
2. Phase 2 (File Substrate) → Phase 3, 4, 5, 6, 7
3. Phase 3 (Agents) → Phase 4, 6, 7
4. Phase 4 (Runtime Loop) → Phase 6, 7
5. Phase 5 (Frontend) → Parallel with 4, 6, 7
6. Phase 6 (Idle/Id) → Phase 7
7. Phase 7 (Superego) → Phase 8
8. Phase 8 (Testing/Docs) → Final validation

### Parallelization Opportunities
- **2.2 & 2.3** can be done simultaneously
- **3.2, 3.3, 3.4, 3.5** can be done simultaneously (after 3.1)
- **Phase 5** can largely be done in parallel with Phase 4, 6, 7
- **8.1 & 8.2** can be done simultaneously

---

## Estimated Timeline

- **Phase 1**: 1-2 days (foundation setup)
- **Phase 2**: 3-4 days (substrate system)
- **Phase 3**: 5-7 days (agent roles & Claude integration - most complex)
- **Phase 4**: 3-4 days (runtime loop)
- **Phase 5**: 4-5 days (frontend UI)
- **Phase 6**: 2-3 days (idle behavior)
- **Phase 7**: 3-4 days (Superego evaluation)
- **Phase 8**: 4-5 days (testing & documentation)

**Total Estimated Time**: 25-34 days for a single developer

With parallelization and a small team (2-3 developers), this could potentially be compressed to 15-20 days.

---

## Revision History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2026-02-08 | Initial implementation plan created | Copilot |


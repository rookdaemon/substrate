# Copilot Coding Agent Instructions

This repository is **Substrate** - a self-referential AI agent orchestration shell that wraps Claude Code in a continuous execution loop with four cognitive roles (Ego, Subconscious, Superego, Id), persistent file-based memory, and autonomous goal-setting capabilities.

## Repository Overview

- **Purpose**: Self-referential agent shell with persistent markdown-based memory ("substrate")
- **Architecture**: Monorepo with Node.js/TypeScript backend (server/) and React/Vite frontend (client/)
- **AI Integration**: Claude Code CLI via stream-json parsing
- **Storage**: 12 markdown files serve as shared memory with two-tier knowledge system (index + detail subdirs)
- **Agent Roles**: Ego (planner), Subconscious (worker), Superego (auditor), Id (motivation)

## Quick Start for New Agents

### Repository Structure

```
substrate/
├── server/              # Node.js + TypeScript backend (v0.2.2)
│   ├── src/
│   │   ├── agents/      # Four cognitive roles + Claude integration
│   │   ├── loop/        # LoopOrchestrator (main execution engine)
│   │   ├── substrate/   # File I/O, abstractions, templates
│   │   ├── session/     # SDK session management
│   │   ├── evaluation/  # Health analyzers (Drift, Security, etc.)
│   │   ├── conversation/# Conversation management with compaction
│   │   └── cli.ts       # CLI entry point
│   └── tests/           # Jest tests (488 tests / 54 suites)
├── client/              # React + Vite frontend (v0.1.0)
│   ├── src/
│   │   ├── components/  # 11 React components
│   │   └── hooks/       # useWebSocket, useApi, useNotifications
│   └── tests/           # Vitest tests (45 tests)
└── package.json         # Workspace root
```

### Essential Commands

```bash
# Installation & Setup
npm install                              # Install all workspace dependencies
cd server && npm run init                # Initialize substrate files (first time only)

# Development
npm run server:dev                       # Start backend with file watching (tsx watch)
npm run client:dev                       # Start frontend dev server (Vite)

# Building
npm run build                            # Build both workspaces
cd server && npm run build               # Build server only (tsc → dist/)
cd client && npm run build               # Build client only (Vite)

# Testing
npm test                                 # Run all workspace tests
cd server && npm test                    # Run Jest tests (server)
cd client && npm test                    # Run Vitest tests (client)

# Linting
npm run lint                             # Lint all workspaces
cd server && npm run lint                # Lint server only
cd client && npm run lint                # Lint client only

# Substrate Operations
cd server
npm run backup                           # Create tar.gz snapshot of substrate
npm run restore                          # Restore latest backup
npm run transfer -- --dest user@host     # Transfer substrate via rsync
npm run logs                             # View debug.log
```

**Important**: The server uses a supervisor pattern. Running `npm run start` compiles TypeScript then launches `dist/supervisor.js`, which manages the server lifecycle with auto-restart on exit code 75.

## Build, Test, and Lint Setup

### TypeScript Configuration

- **Target**: ES2022
- **Module**: Node16 (server), ESNext (client)
- **Strict Mode**: Enabled (`strict: true`)
- **Server Output**: `dist/` directory
- **Source Maps**: Enabled with declaration files

### Testing Frameworks

| Workspace | Framework | Test Files | Config |
|-----------|-----------|------------|--------|
| Server | Jest + ts-jest | `tests/**/*.test.ts` | `jest.config.js` |
| Client | Vitest + happy-dom | `tests/**/*.test.ts` | `vitest.config.ts` |

**Key Test Patterns**:
- Use `beforeEach()` for setup, `describe()` for grouping, `it()` for tests
- Test timeout: 4 seconds (configurable in config files)
- Tests use in-memory implementations: `InMemoryFileSystem`, `FixedClock`, `InMemorySessionLauncher`

**Common Test Gotcha**: Do NOT use `npm test -w server` (workspace resolution errors). Instead:
```bash
cd server && npm test
cd client && npm test
```

### ESLint Configuration

- **Format**: Flat config (`eslint.config.mjs`)
- **Parser**: `@typescript-eslint/parser`
- **Rules**: TypeScript recommended + custom rule for unused vars
- **Unused Params**: Prefix with `_` to ignore (e.g., `_unusedParam`)
- **Ignored**: `dist/`, `node_modules/`, `jest.config.ts`

## Coding Conventions

### Naming Conventions

- **Classes**: PascalCase (e.g., `Ego`, `LoopOrchestrator`, `SessionManager`)
- **Files**: Match class names (e.g., `Ego.ts`, `SessionManager.ts`); utilities are camelCase
- **Interfaces**: PascalCase with `I` prefix for abstractions (e.g., `IFileSystem`, `IClock`, `ISessionLauncher`)
- **Functions**: camelCase (e.g., `apiGet()`, `resolveConfig()`)
- **Constants**: UPPER_SNAKE_CASE (e.g., `RESTART_EXIT_CODE`, `ROLE_PERMISSIONS`)

### Dependency Injection Pattern

**Always use constructor injection for testability**. All I/O and external dependencies are abstracted:

```typescript
// Production dependencies
import { NodeFileSystem } from "./substrate/abstractions/NodeFileSystem";
import { SystemClock } from "./substrate/abstractions/SystemClock";

// Test doubles
import { InMemoryFileSystem } from "./substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "./substrate/abstractions/FixedClock";
```

**Key Interfaces**:
- `IFileSystem` - Abstract file operations (readFile, writeFile, mkdir, stat)
- `IClock` - Time abstraction (single `now()` method for mocking timestamps)
- `ISessionLauncher` - Claude Code session execution

**Pattern Example**:
```typescript
class Ego {
  constructor(
    private planReader: Reader,
    private planWriter: OverwriteWriter,
    private conversationWriter: AppendOnlyWriter,
    private sessionLauncher: ISessionLauncher,
    private clock: IClock,
    // ... other dependencies
  ) {}
}
```

### Error Handling

- **Try-catch**: Wrap async operations, return safe defaults on error
- **Assertions**: Use explicit checks before operations (e.g., `assertCanRead()`, `assertCanWrite()`)
- **Error Context**: Always include context in error messages (e.g., "Decision failed: {message}")
- **Result Objects**: Return `{ success: boolean, error?: string }` for session results

### Time Operations

**ALWAYS inject timestamps via `IClock`**:
```typescript
// Good
const timestamp = this.clock.now().toISOString();

// Bad - don't use directly
const timestamp = new Date().toISOString();
```

This enables tests to exercise code with known timestamps using `FixedClock`.

## Architecture Patterns

### Substrate Files (12 Markdown Files)

The system's persistent memory consists of 12 markdown files:

| File | Write Mode | Purpose |
|------|-----------|---------|
| PLAN.md | OVERWRITE | Current task tree with `## Current Goal` and `## Tasks` |
| PROGRESS.md | APPEND | Timestamped execution log: `[ISO-timestamp] [ROLE] message` |
| CONVERSATION.md | APPEND | User/system message transcript (compacts hourly) |
| MEMORY.md | OVERWRITE | Long-term knowledge index → `memory/*.md` |
| HABITS.md | OVERWRITE | Behavioral routines → `habits/*.md` |
| SKILLS.md | OVERWRITE | Learned capabilities → `skills/*.md` |
| VALUES.md | OVERWRITE | Optimization targets → `values/*.md` |
| ID.md | OVERWRITE | Motivational drives → `id/*.md` |
| SECURITY.md | OVERWRITE | Security policies → `security/*.md` |
| CHARTER.md | OVERWRITE | Operational doctrine |
| SUPEREGO.md | OVERWRITE | Evaluation criteria → `superego/*.md` |
| CLAUDE.md | OVERWRITE | Claude Code capabilities |

**Two-Tier Knowledge**: Main files contain concise indexes with `@`-references (e.g., `@memory/topic.md`) pointing to detailed content in subdirectories.

### Agent Role Permissions

Each agent role has specific file access permissions enforced by `PermissionChecker`:

- **Ego**: Reads PLAN/MEMORY/HABITS/SKILLS/VALUES/CHARTER/PROGRESS/CONVERSATION; Writes PLAN (overwrite), CONVERSATION (append)
- **Subconscious**: Reads PLAN/MEMORY/HABITS/SKILLS/VALUES/PROGRESS; Writes PLAN/SKILLS/MEMORY (overwrite), PROGRESS/CONVERSATION (append)
- **Superego**: Reads all 12 files; Writes PROGRESS (append only)
- **Id**: Reads ID/VALUES/PLAN/PROGRESS/SKILLS/MEMORY; No writes

**When adding file operations**: Always check permissions via `PermissionChecker` before read/write.

### Model Selection Strategy

The `TaskClassifier` routes operations to appropriate Claude models based on complexity:

- **Strategic Operations** (default: `opus`) - Complex reasoning:
  - `Ego.decide()` - Executive decision-making
  - `Ego.respondToMessage()` - Context-aware conversation
  - `Id.generateDrives()` - Novel goal generation
  - `Superego.audit()` - Full substrate analysis
  
- **Tactical Operations** (default: `sonnet`) - Routine tasks:
  - `Subconscious.execute()` - Task execution
  - `Superego.evaluateProposals()` - Binary decisions
  - `Id.detectIdle()` - Deterministic checks

Configure via `config.json`:
```json
{
  "strategicModel": "opus",
  "tacticalModel": "sonnet"
}
```

## Configuration System

### Priority Order (highest to lowest)

1. Environment variables (`SUBSTRATE_PATH`, `PORT`)
2. `--config /path/to/config.json` (CLI flag)
3. `config.json` in current working directory
4. `~/.config/substrate/config.json` (XDG config)
5. Built-in defaults

### XDG Directory Conventions

- **Config**: `$XDG_CONFIG_HOME/substrate` (default: `~/.config/substrate`)
- **Data**: `$XDG_DATA_HOME/substrate` (default: `~/.local/share/substrate`)
- **Platform overrides**: macOS uses `~/Library/Preferences` and `~/Library/Application Support`

### Key Configuration Fields

```json
{
  "substratePath": "~/.local/share/substrate/substrate",
  "workingDirectory": "~/.local/share/substrate",
  "sourceCodePath": "/path/to/substrate",
  "backupPath": "~/.local/share/substrate-backups",
  "port": 3000,
  "strategicModel": "opus",
  "tacticalModel": "sonnet",
  "autoStartOnFirstRun": false,
  "autoStartAfterRestart": true
}
```

## Common Patterns and Gotchas

### Adding a New Substrate File

1. Add type to `SubstrateFileType` enum in `server/src/substrate/types.ts`
2. Add spec to `SUBSTRATE_FILE_SPECS` with `fileName`, `writeMode`, `required`
3. Update `PermissionChecker` in `server/src/agents/permissions.ts`
4. Add template in `server/src/substrate/templates/templates.ts`

### Adding a New Agent Role

1. Add role to `AgentRole` enum in `server/src/agents/roles.ts`
2. Define permissions in `server/src/agents/permissions.ts`
3. Create agent class in `server/src/agents/roles/` with reader/writer deps
4. Wire into `createApplication()` factory in `server/src/loop/createApplication.ts`
5. Add tests using `InMemoryFileSystem` and `FixedClock`

### Conversation Compaction

`ConversationManager` automatically compacts `CONVERSATION.md` every hour:
- **Trigger**: Before each append if 1+ hour elapsed since last compaction
- **Process**: Calls `IConversationCompactor.compact()` with 1-hour-old ISO timestamp
- **Bypass**: Writes directly via `FileLock` (maintenance operation, skips permission checks)
- **Testing**: Use `forceCompaction()` and `resetCompactionTimer()` methods

### Supervisor Restart Mechanism

The supervisor (`server/src/supervisor.ts`) manages server lifecycle:
- **Exit code 75**: Triggers rebuild (`tsc`) and restart
- **Other codes**: Propagate and exit (no restart)
- **First run**: Adds `--forceStart` if `autoStartOnFirstRun=true` (default: false)
- **After restart**: Adds `--forceStart` if `autoStartAfterRestart=true` (default: true)
- **Build retry**: Every 10 seconds on build failure

### Claude Integration

**Process Management**:
- **Hard ceiling**: 30 minutes absolute maximum
- **Idle watchdog**: 2 minutes of no output kills process
- **Idle timer resets**: On any stdout/stderr output

**Prompt Building**:
- System prompts built synchronously via `buildSystemPrompt(role)`
- File contents included via `@/substrate/FILE.md` references (Claude Code syntax)
- Context refs via `getContextReferences(role)` for each agent

**Stream Parsing**:
- Claude output is stream-json format (one JSON object per line)
- `StreamJsonParser` converts to typed `ProcessLogEntry` objects
- Entry types: `thinking`, `text`, `tool_use`, `tool_result`, `status`
- Broadcast as `process_output` WebSocket events

## Troubleshooting Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| **Substrate validation fails** | Missing `# Heading` as first line | Run `cd server && npm run init` |
| **Port already in use** | Default port 3000 conflict | Set `PORT=3001` env var or in config.json |
| **Claude CLI not found** | CLI not on PATH or not authenticated | Run `claude --version` and re-authenticate |
| **Process idle timeout (2min)** | No output from Claude for 2 minutes | Check `debug.log` for last activity; Claude likely stuck |
| **WebSocket disconnects** | Backend not running | Verify server on expected port (default: 3000) |
| **Workspace test failures** | npm workspace resolution issue | Run `cd server && npx jest` directly (not `npm test -w server`) |
| **TypeScript errors after pull** | Stale `dist/` directory | Run `cd server && npm run build` to rebuild |

## API Endpoints

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
| GET | `/api/health` | Run all 5 health analyzers |
| GET | `/api/reports` | List governance reports |
| GET | `/api/reports/latest` | Get latest governance report |

WebSocket endpoint: `/ws` (proxied by Vite in dev mode)

## Versioning

**Always update package.json versions before committing significant changes**:
- Server: `/server/package.json` (currently v0.2.2)
- Client: `/client/package.json` (currently v0.1.0)
- Use at least patch-level increments for meaningful updates

## Memory Storage for This Repository

The following memories have been stored for this codebase:

1. **Conversation Compaction**: CONVERSATION.md compacts hourly using ConversationManager, which delegates to ConversationCompactor via ISessionLauncher
2. **Testing Patterns**: Use IClock (FixedClock for tests) for time operations and ISessionLauncher (InMemorySessionLauncher for tests) for Claude interactions
3. **Model Selection**: TaskClassifier routes operations to strategicModel (opus) or tacticalModel (sonnet) based on operation complexity

When working on this codebase, verify these facts against current implementation and store new patterns you discover using the store_memory tool.

## Key Files to Reference

- **README.md**: Comprehensive user and developer guide
- **IMPLEMENTATION_PLAN.md**: Complete v1 implementation plan with all phases
- **server/src/config.ts**: Configuration resolution logic
- **server/src/paths.ts**: XDG directory conventions
- **server/src/supervisor.ts**: Restart mechanism
- **server/src/agents/permissions.ts**: Role-based file access matrix
- **server/src/loop/LoopOrchestrator.ts**: Main execution loop
- **server/src/substrate/types.ts**: Substrate file type definitions

## Additional Notes

- **No CI/CD**: This repository has no GitHub Actions workflows or pre-commit hooks
- **Node.js**: Requires 20.0.0+ (specified in root package.json engines)
- **Dependencies**: Uses npm workspaces for monorepo management
- **File Structure**: Each substrate file must have a `# Heading` as its first line
- **Debugging**: Check `debug.log` for detailed execution logs (500KB rotation)

## When Making Changes

1. **Always preserve testability**: Inject all dependencies via constructor
2. **Always mock time**: Use `IClock` instead of `new Date()`
3. **Always check permissions**: Use `PermissionChecker` for file operations
4. **Always update versions**: Increment package.json before significant commits
5. **Always test**: Run relevant tests before committing
6. **Always document**: Update relevant .md files if changing core behavior

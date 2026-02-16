# TinyBus Implementation Summary

## Overview

TinyBus is a lightweight, environment-agnostic message routing subsystem implemented in ~345 lines of core code. It provides a clean abstraction for routing structured messages between providers with zero external dependencies.

## Architecture

```
Provider A ──┐
             │
Provider B ──┼──> TinyBus Core ──> Router ──> Destination Provider(s)
             │
Provider C ──┘
```

## Core Components

### 1. Message (`Message.ts`)
- **Structure**: id, type, schema, timestamp, source?, destination?, payload?, meta?
- **Factory**: `createMessage()` generates unique IDs and timestamps
- **Type Format**: Supports dot notation (e.g., `agent.command.exec`) and URI forms

### 2. Provider Interface (`Provider.ts`)
- `id: string` - Unique identifier
- `isReady(): Promise<boolean>` - Readiness check
- `start(): Promise<void>` - Initialize resources
- `stop(): Promise<void>` - Cleanup resources
- `send(message): Promise<void>` - Receive routed messages
- `onMessage(handler)` - Register inbound message handler

### 3. Router (`Router.ts`)
- **DefaultRouter**: Implements two routing modes:
  1. **Direct**: Routes to specific `destination` provider
  2. **Broadcast**: Routes to all providers except `source`

### 4. TinyBus (`TinyBus.ts`)
Main orchestrator that:
- Manages provider registration and lifecycle
- Routes messages via Router
- Emits lifecycle events (started, stopped, inbound, outbound, routed, error, dropped)
- Isolates provider errors (doesn't crash on send failures)
- Validates provider readiness before starting

## Event System

TinyBus emits non-blocking events:
- `tinybus.started` - Bus started successfully
- `tinybus.stopped` - Bus stopped successfully
- `message.inbound` - Message received from provider
- `message.outbound` - Message being routed
- `message.routed` - Message delivered to provider
- `message.error` - Provider send error
- `message.dropped` - No target providers found

## Providers

### MemoryProvider (`providers/MemoryProvider.ts`)
In-memory testing provider that:
- Stores sent/received messages for inspection
- Supports message injection for testing
- Provides history tracking and clearing

## Usage Example

```typescript
import { TinyBus, MemoryProvider, createMessage } from "./tinybus";

// Create bus and providers
const bus = new TinyBus();
const provider1 = new MemoryProvider("provider-1");
const provider2 = new MemoryProvider("provider-2");

// Register providers
bus.registerProvider(provider1);
bus.registerProvider(provider2);

// Start bus (starts all providers)
await bus.start();

// Send message via provider1
await provider1.injectMessage(
  createMessage({
    type: "agent.command.exec",
    source: "provider-1",
    destination: "provider-2",
    payload: { command: "test" },
  })
);

// provider2 receives the message
const received = provider2.getSentMessages();
console.log(received[0].type); // "agent.command.exec"

// Stop bus
await bus.stop();
```

## Testing

53 comprehensive tests covering:
- Message creation and validation
- Router direct and broadcast modes
- TinyBus lifecycle management
- Provider registration and readiness
- Error isolation
- Event emissions
- Message flow end-to-end

Run tests: `npm test -- tinybus`

## Extractability

TinyBus core is fully extractable:
- ✅ Zero imports from orchestrator code
- ✅ No MCP SDK dependencies
- ✅ No HTTP library imports
- ✅ No process/environment references
- ✅ No external runtime dependencies

The entire `tinybus/` directory can be moved to a standalone package.

## Integration Points

### Future MCP HTTP Provider
Will need to:
1. Implement Provider interface
2. Expose `send(msg)` tool via MCP SDK
3. Wrap messages with generated id/timestamp/source
4. Call `TinyBus.publish()` for outbound messages

### Inbound Injection Model
Messages routed to agent providers should be:
1. Buffered externally (memory queue)
2. Pulled by orchestrator
3. Injected into agent prompt context
4. Marked processed by orchestration logic

TinyBus does NOT manage agent queue state - that's the orchestrator's responsibility.

## Configuration

None required. TinyBus uses dependency injection:
- Custom Router can be provided to constructor
- Providers are registered imperatively
- Event listeners registered via `.on()` method

## Performance Characteristics

- Fully async/promise-driven
- No synchronous dispatch
- Parallel delivery to multiple providers
- Non-blocking event emissions
- Single-threaded (no locking primitives needed)

## Non-Goals (Deferred)

- Message persistence
- Retry mechanisms
- Delivery guarantees
- Correlation IDs
- Schema validation
- Backpressure controls

These can be added later via `meta` field or custom providers.

## Files

```
server/src/tinybus/
├── core/
│   ├── Message.ts       (62 lines)
│   ├── Provider.ts      (40 lines)
│   ├── Router.ts        (35 lines)
│   └── TinyBus.ts       (208 lines)
├── providers/
│   └── MemoryProvider.ts (82 lines)
└── index.ts             (17 lines)

server/tests/tinybus/
├── core/
│   ├── Message.test.ts     (82 lines, 8 tests)
│   ├── Router.test.ts      (116 lines, 9 tests)
│   └── TinyBus.test.ts     (381 lines, 32 tests)
└── providers/
    └── MemoryProvider.test.ts (202 lines, 14 tests)

Total: ~1225 lines (444 implementation + 781 tests)
```

## Next Steps

1. **MCP HTTP Provider**: Integrate with MCP SDK to expose `send(msg)` tool
2. **Agora Provider**: Integrate with existing Agora relay for cross-instance messaging
3. **Process Provider**: Enable messaging between Node.js processes
4. **Orchestrator Integration**: Wire TinyBus into LoopOrchestrator
5. **Agent Inbound Queue**: Implement external buffering and prompt injection

## Version

Implemented in server package v0.2.9

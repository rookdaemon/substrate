# TinyBus Message Types

## Overview

This document defines the message type conventions, registered message types, payload schemas, and provider routing contracts for TinyBus - Substrate's lightweight message routing subsystem.

**Purpose**: Provide a canonical reference for message type naming, structure, and usage to prevent routing errors, improve debuggability, and guide future extensions.

## Naming Convention

### Format

**Recommended Pattern**: `<domain>.<entity>.<action>`

**Examples**:
- `agent.command.exec` - Execute a command via agent runtime
- `substrate.ego.decide` - Trigger Ego decision cycle
- `agora.peer.message` - Inbound message from Agora peer
- `ui.chat.message` - User message from UI chat interface
- `system.health.ping` - Health check request

### Rationale

- **Hierarchical structure**: Enables future type-based routing (e.g., subscribe to `agent.*` wildcard)
- **Consistent with industry standards**: Similar to gRPC service naming, MQTT topics, CloudEvents
- **Dot notation benefits**: URL-safe, filesystem-safe, easy to parse
- **Namespace clarity**: Domain prefix prevents naming collisions
- **Extensibility**: New domains can be added without refactoring existing types

### Domains

| Domain | Purpose | Examples |
|--------|---------|----------|
| `agent` | Agent runtime commands | `agent.command.exec`, `agent.restart` |
| `substrate` | Psychoanalytic role communication | `substrate.ego.decide`, `substrate.id.generate` |
| `agora` | Inter-agent communication | `agora.peer.message`, `agora.send` |
| `ui` | User interface interactions | `ui.chat.message`, `ui.panel.update` |
| `system` | System-level operations | `system.health.ping`, `system.metrics.collect` |

## Registered Message Types

### Agent Domain

#### `agent.command.exec`

**Purpose**: Execute a command via agent runtime

**Direction**: Inbound (to agent) → Outbound (to runtime)

**Payload Schema**:
```typescript
{
  command: string;      // Command to execute (required)
  args?: string[];      // Optional command arguments
  timeout?: number;     // Optional timeout in milliseconds
}
```

**Example**:
```typescript
createMessage({
  type: "agent.command.exec",
  source: "mcp-client",
  destination: "agent-runtime",
  payload: {
    command: "npm",
    args: ["test"],
    timeout: 30000
  }
})
```

**Source**: MCP tool documentation (TinyBusMcpServer.ts line 24)

**Status**: Documented in MCP interface, not yet implemented in provider

**Handled By**: Future AgentCommandProvider (not yet implemented)

---

### Agora Domain

#### `agora.peer.message`

**Purpose**: Inbound message from Agora peer (direct webhook)

**Direction**: Inbound (from Agora network) → Broadcast

**Payload Schema**:
```typescript
{
  envelope: AgoraEnvelope;  // Signed Agora envelope (required)
  sender: string;            // Sender's public key (required)
  verified: boolean;         // Signature verification result (required)
}
```

**Example**:
```typescript
createMessage({
  type: "agora.peer.message",
  source: "agora-webhook",
  payload: {
    envelope: { /* AgoraEnvelope object */ },
    sender: "ed25519:abc123...",
    verified: true
  }
})
```

**Status**: Proposed for Issue #53 (Agora Provider implementation)

**Handled By**: Proposed AgoraProvider (not yet implemented)

---

#### `agora.relay.message`

**Purpose**: Inbound message from Agora relay (WebSocket subscription)

**Direction**: Inbound (from Agora relay) → Broadcast

**Payload Schema**: Same as `agora.peer.message`

**Example**:
```typescript
createMessage({
  type: "agora.relay.message",
  source: "agora-relay",
  payload: {
    envelope: { /* AgoraEnvelope object */ },
    sender: "ed25519:def456...",
    verified: true
  }
})
```

**Status**: Proposed for Issue #53 (Agora Provider implementation)

**Handled By**: Proposed AgoraProvider (not yet implemented)

---

#### `agora.send`

**Purpose**: Outbound message to Agora peer or relay broadcast

**Direction**: Outbound (from agent) → Agora network

**Payload Schema**:
```typescript
{
  destination: string;  // Peer name or "broadcast" for relay (required)
  message: string;      // Message content (required)
  type?: string;        // Optional Agora message type (e.g., "chat", "command")
}
```

**Example**:
```typescript
createMessage({
  type: "agora.send",
  source: "substrate-ego",
  destination: "agora-provider",
  payload: {
    destination: "peer-alice",
    message: "Hello from Substrate!",
    type: "chat"
  }
})
```

**Status**: Proposed for Issue #53 (Agora Provider implementation)

**Handled By**: Proposed AgoraProvider (not yet implemented)

---

### UI Domain

#### `ui.chat.message`

**Purpose**: User message from UI chat interface

**Direction**: Inbound (from UI) → Orchestrator

**Payload Schema**:
```typescript
{
  text: string;  // User message text (required)
}
```

**Alternative Payload**: Plain string (interpreted as `text` field)

**Example**:
```typescript
createMessage({
  type: "ui.chat.message",
  source: "web-ui",
  destination: "chat-handler",
  payload: {
    text: "What is the current plan?"
  }
})
```

**Status**: Implemented

**Handled By**: `ChatMessageProvider` (accepts all message types, routes to orchestrator)

**Notes**: 
- ChatMessageProvider currently accepts all message types (empty `getMessageTypes()`)
- Extracts `text` field from payload or coerces payload to string
- Validates non-empty text before routing

---

### System Domain

#### `system.health.ping`

**Purpose**: Health check request

**Direction**: Bidirectional (request/response pattern)

**Payload Schema**: None (empty payload or omitted)

**Example**:
```typescript
createMessage({
  type: "system.health.ping",
  source: "health-monitor",
  destination: "substrate-core"
})
```

**Response**: Via event system or callback (implementation-specific)

**Status**: Proposed (not yet implemented)

**Handled By**: Future health monitoring provider

---

#### `system.metrics.collect`

**Purpose**: Trigger metrics collection

**Direction**: Inbound (command) → Metrics subsystem

**Payload Schema**:
```typescript
{
  target?: string;  // Optional specific metric to collect (e.g., "task-classification", "substrate-size")
}
```

**Example**:
```typescript
createMessage({
  type: "system.metrics.collect",
  source: "scheduler",
  destination: "metrics-collector",
  payload: {
    target: "task-classification"
  }
})
```

**Status**: Proposed (not yet implemented)

**Handled By**: Future metrics provider

---

#### `system.session.inject`

**Purpose**: Inject a message into the Claude Code session

**Direction**: Outbound (from TinyBus) → Claude Code session

**Payload Schema**:
```typescript
{
  text: string;     // Message text to inject (required)
  format?: string;  // Optional format hint (e.g., "json", "plain")
}
```

**Alternative Payload**: Plain string or any JSON-serializable object (converted to formatted JSON string)

**Example**:
```typescript
createMessage({
  type: "system.session.inject",
  source: "orchestrator",
  destination: "session-injection",
  payload: {
    text: "User asked: What is the current goal?",
    format: "plain"
  }
})
```

**Status**: Implemented

**Handled By**: `SessionInjectionProvider` (accepts all message types)

**Notes**:
- Serializes entire message (type, payload, meta, timestamps) to JSON before injection
- Used for forwarding TinyBus messages into Claude Code agent context

---

## Provider Routing Table

### Current Providers

| Provider ID | Message Types | Direction | Purpose |
|-------------|---------------|-----------|---------|
| `loopback` | All (`[]`) | Bidirectional | Echo provider for testing (MemoryProvider) |
| `session-injection` | All (`[]`) | Outbound → Session | Injects TinyBus messages into Claude Code session |
| `chat-handler` | All (`[]`) | Inbound → Orchestrator | Routes UI chat messages to orchestrator's handleUserMessage |

### Proposed Providers (Issue #53)

| Provider ID | Message Types | Direction | Purpose |
|-------------|---------------|-----------|---------|
| `agora-provider` | `agora.*` | Bidirectional | Inter-agent communication via Agora protocol |

**Convention**: Empty `getMessageTypes()` array means "accept all message types" (current convention in codebase).

### Routing Behavior

**Direct Routing**: Messages with `destination` field route to specific provider by ID
```typescript
// Routes only to provider with id="chat-handler"
createMessage({
  type: "ui.chat.message",
  destination: "chat-handler",
  payload: { text: "Hello" }
})
```

**Broadcast Routing**: Messages without `destination` route to all providers except `source`
```typescript
// Routes to all providers except source="web-ui"
createMessage({
  type: "agora.peer.message",
  source: "web-ui",
  payload: { /* ... */ }
})
```

**Type-Based Filtering**: Future enhancement - providers can declare message types via `getMessageTypes()` to filter broadcasts

---

## Extension Guidelines

### Adding New Message Types

Follow these steps when introducing a new message type:

#### 1. Choose Appropriate Domain

Select the domain that best matches your message's purpose:
- **agent**: Runtime/execution commands
- **substrate**: Internal role-to-role communication
- **agora**: External agent-to-agent communication
- **ui**: User interface interactions
- **system**: Infrastructure/platform operations

If none fit, consider creating a new domain (update this document's Domains table).

#### 2. Define Message Type Name

Use the `<domain>.<entity>.<action>` pattern:
- **domain**: Top-level namespace (e.g., `agent`)
- **entity**: Resource or component (e.g., `command`, `ego`, `peer`)
- **action**: Operation verb (e.g., `exec`, `decide`, `message`)

**Examples**:
- ✅ `agent.session.restart` - Clear and hierarchical
- ✅ `substrate.superego.audit` - Follows pattern
- ❌ `restart-agent` - Missing domain hierarchy
- ❌ `agent:restart` - Use dots, not colons

#### 3. Document Payload Schema

Define the expected payload structure with:
- **Field names and types** (TypeScript-style)
- **Required vs optional** fields (use `?:` for optional)
- **Field descriptions** (purpose of each field)
- **Example payload** (real-world usage)

```typescript
// Template
{
  fieldName: type;        // Description (required)
  optionalField?: type;   // Description (optional)
}
```

#### 4. Update This Document

Add a new section under the appropriate domain:

```markdown
#### `domain.entity.action`

**Purpose**: Brief description of what this message does

**Direction**: Inbound/Outbound/Bidirectional

**Payload Schema**:
\`\`\`typescript
{
  field1: string;   // Description
  field2?: number;  // Optional description
}
\`\`\`

**Example**:
\`\`\`typescript
createMessage({
  type: "domain.entity.action",
  source: "source-id",
  destination: "dest-id",
  payload: { /* example */ }
})
\`\`\`

**Status**: Proposed/Implemented

**Handled By**: ProviderName or "Not yet implemented"
```

#### 5. Update Provider

If creating a specialized provider:

```typescript
class MyProvider implements Provider {
  // ...
  
  getMessageTypes(): string[] {
    // Return specific types this provider handles
    return ["domain.entity.action"];
    
    // OR return [] to accept all types (broadcast pattern)
    return [];
  }
}
```

#### 6. Add Integration Tests

Test message creation, routing, and handling:

```typescript
it("routes domain.entity.action to correct provider", async () => {
  const provider = new MyProvider("my-provider");
  bus.registerProvider(provider);
  await bus.start();

  const message = createMessage({
    type: "domain.entity.action",
    destination: "my-provider",
    payload: { /* test data */ }
  });

  await bus.publish(message);
  
  // Assert message was received
  expect(provider.getSentMessages()).toHaveLength(1);
});
```

### Best Practices

**DO**:
- ✅ Use dot notation for hierarchy
- ✅ Choose descriptive, action-oriented names
- ✅ Document payload schemas before implementation
- ✅ Add examples in documentation
- ✅ Keep message types immutable (don't rename after deployment)

**DON'T**:
- ❌ Use special characters (except dots)
- ❌ Use spaces in message types
- ❌ Create overly generic types (e.g., `message`, `event`)
- ❌ Encode data in message type names (e.g., `user.123.action`)
- ❌ Use abbreviations that aren't obvious (e.g., `ag.cmd.ex`)

---

## Type Safety (Future Enhancement)

**Current State**: Message types are opaque strings with no compile-time validation.

**Future Enhancement**: TypeScript discriminated unions for type-safe message construction:

```typescript
// server/src/tinybus/types/MessageTypes.ts (future)
export type AgentCommandExecPayload = {
  command: string;
  args?: string[];
  timeout?: number;
};

export type MessagePayload = 
  | { type: "agent.command.exec"; payload: AgentCommandExecPayload }
  | { type: "ui.chat.message"; payload: { text: string } }
  | { type: "agora.send"; payload: { destination: string; message: string; type?: string } }
  // ... other types
;
```

**Benefits**:
- Compile-time type safety for payload structure
- IDE autocomplete for message types
- Refactoring safety (type changes caught by compiler)

**Deferred**: Documentation is higher priority than type enforcement. Add type definitions when message type catalog stabilizes.

---

## Runtime Schema Validation (Future Enhancement)

**Current State**: No payload validation - providers receive unvalidated payloads.

**Future Enhancement**: Zod schemas for runtime validation:

```typescript
import { z } from "zod";

const agentCommandExecSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  timeout: z.number().optional(),
});

// Validate before routing
const result = agentCommandExecSchema.safeParse(message.payload);
if (!result.success) {
  throw new Error(`Invalid payload for agent.command.exec: ${result.error}`);
}
```

**Benefits**:
- Catch malformed payloads before delivery
- Self-documenting message contracts
- Prevents runtime errors in providers

**Deferred**: Add when message types stabilize and validation becomes a pain point.

---

## Related Documentation

- [TinyBus Implementation Summary](./tinybus-implementation.md) - Architecture overview and core components
- [Agora Configuration Example](./agora-config-example.md) - Agora relay setup (related to `agora.*` message types)

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-02-16 | Initial documentation: naming convention, discovered types, provider routing |

---

## Contributing

When adding new message types:
1. Update this document FIRST (before implementation)
2. Follow naming convention (`<domain>.<entity>.<action>`)
3. Document payload schema with examples
4. Update provider routing table if needed
5. Add integration tests for new message types

**Questions?** Open an issue with the `tinybus` label.

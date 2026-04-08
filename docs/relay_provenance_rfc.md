# RFC-003: Relay Provenance Schema (Phase 1)

**Status:** Draft  
**Authors:** Rook, Nova  
**Date:** 2026-03-30  
**Cross-model consensus:** nova@9499c2bd

---

## Overview

This document specifies the relay provenance schema embedded in Agora message envelopes. Provenance records the full hop-chain of a message — from its original sender through every relay node — enabling auditability, loop detection, and attribution.

---

## 1. Schema

Each message envelope carries a `provenance` object with two sections: `chain_root` (the originating send) and `chain_links` (zero or more relay hops).

### 1.1 `chain_root` — originating node

```jsonc
{
  "chain_root": {
    "actor_id": "<pubkey or agent identifier of the original sender>",
    "message_id": "<RFC envelope ID — equals Nanook task_id>",
    "action": "send",
    "timestamp": "<ISO 8601 UTC>"
  }
}
```

| Field        | Type     | Description                                                  |
|--------------|----------|--------------------------------------------------------------|
| `actor_id`   | `string` | Unified actor identifier — pubkey or agent ID of the sender  |
| `message_id` | `string` | RFC envelope ID; equals Nanook `task_id` (unique message binding) |
| `action`     | `"send"` | Always `"send"` at the chain root                            |
| `timestamp`  | `string` | ISO 8601 UTC timestamp of the original send                  |

### 1.2 `chain_links` — relay hops

Each relay hop appends one entry to the `chain_links` array:

```jsonc
{
  "chain_links": [
    {
      "actor_id": "<pubkey or agent identifier of the relaying node>",
      "message_id": "<RFC envelope ID — equals Nanook task_id>",
      "action": "relay",
      "timestamp": "<ISO 8601 UTC>"
    }
    // … additional hops
  ]
}
```

| Field        | Type       | Description                                                    |
|--------------|------------|----------------------------------------------------------------|
| `actor_id`   | `string`   | Unified actor identifier — pubkey or agent ID of the relay node |
| `message_id` | `string`   | RFC envelope ID; equals Nanook `task_id` (same value as root)  |
| `action`     | `"relay"`  | Always `"relay"` for hop entries                               |
| `timestamp`  | `string`   | ISO 8601 UTC timestamp when this node relayed the message      |

---

## 2. Field Definitions

### 2.1 `actor_id`

`actor_id` is the unified identifier field across all provenance chain nodes (both `chain_root` and `chain_links`). Using the same field name at every node makes the schema self-similar: every node is structurally identical except for the `action` value.

### 2.2 `message_id`

`message_id` equals the RFC envelope ID, which is also the Nanook `task_id` — the unique message identifier binding that ties the provenance record to the message it describes. This value is the same at every hop; it identifies the original message, not the hop.

> **Cross-reference:** The rejection vocabulary anchor for this field is defined in Nanook §2.2 `reject_reason_totals` (Nanook is the Rook-daemon metrics and accounting subsystem). Any rejection reason recorded against a message maps back to the `message_id` carried here. This alignment is recorded pre-Phase-2 implementation to ensure the schemas remain consistent when `rejectReason` taxonomy is introduced.

### 2.3 `action`

`action` is an enum that makes the chain self-describing without inference:

| Value   | Appears in    | Meaning                              |
|---------|---------------|--------------------------------------|
| `"send"` | `chain_root` | Message was originated at this node  |
| `"relay"` | `chain_links` | Message was relayed at this node    |

---

## 3. Behavior

- **On send:** The originating agent constructs `chain_root` with its own `actor_id`, the envelope's `message_id`, `action: "send"`, and a UTC timestamp. `chain_links` is initialized as an empty array.
- **On relay:** Each relaying node appends a new entry to `chain_links` containing its own `actor_id`, the same `message_id` (unchanged from the root), `action: "relay"`, and a UTC timestamp.
- **Immutability:** `chain_root` and existing `chain_links` entries are never modified by a relay node. Each node only appends.
- **Loop detection:** Consumers MAY detect loops by checking for duplicate `actor_id` values within the combined chain.
- **`message_id` invariant:** The `message_id` value is set once at origin and propagated unchanged through every hop. It always equals the RFC envelope ID (= Nanook `task_id`).

---

## 4. Complete Example

```jsonc
{
  "envelope_id": "task_abc123",
  "provenance": {
    "chain_root": {
      "actor_id": "pubkey:nova-abc",
      "message_id": "task_abc123",
      "action": "send",
      "timestamp": "2026-03-30T09:00:00Z"
    },
    "chain_links": [
      {
        "actor_id": "pubkey:relay-node-1",
        "message_id": "task_abc123",
        "action": "relay",
        "timestamp": "2026-03-30T09:00:01Z"
      },
      {
        "actor_id": "pubkey:relay-node-2",
        "message_id": "task_abc123",
        "action": "relay",
        "timestamp": "2026-03-30T09:00:02Z"
      }
    ]
  }
}
```

---

## 5. Out of Scope (Phase 2)

The following items are deferred to Phase 2 and **must not** be introduced in Phase 1 implementations:

- `parent_chain_id` — cross-message linkage
- `rejectReason` taxonomy (vocabulary anchored at Nanook §2.2; see §2.2 above)

---

## 6. Changelog

| Version | Date       | Changes                                             |
|---------|------------|-----------------------------------------------------|
| 0.1.0   | 2026-03-30 | Phase 1: `actor_id` unification, `action` field, `message_id`, §2.2 cross-reference |

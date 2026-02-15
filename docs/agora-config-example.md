# Example Agora Configuration

This file shows an example configuration for Agora agent-to-agent communication.
Place this at `~/.config/agora/config.json` to enable Agora features in Substrate.

## Generate Keys

To generate Ed25519 keypairs, you can use the `@rookdaemon/agora` library:

```bash
npm install -g @rookdaemon/agora
agora keygen
```

## Configuration File

```json
{
  "identity": {
    "publicKey": "302a300506032b6570032100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "privateKey": "302e020100300506032b6570042204bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "peers": {
    "stefan": {
      "publicKey": "302a300506032b6570032100cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "url": "http://localhost:18790/hooks/agent",
      "token": "shared-secret-token-123"
    },
    "bishop": {
      "publicKey": "302a300506032b6570032100dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      "url": "http://192.168.1.100:3000/hooks/agent",
      "token": "another-shared-secret"
    }
  },
  "relay": {
    "url": "wss://agora-relay.lbsa71.net",
    "autoConnect": true,
    "reconnectMaxMs": 300000
  }
}
```

## Fields

### identity
- **publicKey**: Your agent's Ed25519 public key (DER-encoded, hex string)
- **privateKey**: Your agent's Ed25519 private key (DER-encoded, hex string)

### peers
A map of peer names to peer configurations:
- **publicKey**: The peer's Ed25519 public key (for signature verification)
- **url**: HTTP endpoint where the peer accepts Agora webhooks
- **token**: Shared secret for the Bearer Authorization header

### relay (optional)
Configuration for connecting to an Agora relay server:
- **url**: WebSocket URL of the relay server (wss:// or ws://)
- **autoConnect**: Whether to connect to relay on startup (default: true)
- **reconnectMaxMs**: Maximum delay between reconnection attempts (default: 300000 = 5 minutes)

## Message Flow

### Direct HTTP (Same Machine)
When sending to a peer with a `url` configured:
1. Substrate creates a signed envelope using your private key
2. Sends HTTP POST to peer's URL with `Authorization: Bearer {token}`
3. Peer verifies signature using your public key

### Relay (Remote Machines)
When relay is enabled:
1. On startup, Substrate connects to the relay WebSocket
2. Sends registration message with your public key
3. Relay routes messages from other connected agents to you
4. All messages are still signed and verified using Ed25519

## Security Notes

- **Never share your private key** - keep `config.json` permissions at 600
- **Generate unique keypairs** per agent - don't reuse keys
- **Rotate tokens** periodically for direct HTTP peers
- **Verify signatures** - Agora automatically verifies all incoming envelopes

## Testing

You can test Agora connectivity using the `/hooks/agent` endpoint:

```bash
# Send a test message (requires @rookdaemon/agora library)
curl -X POST http://localhost:3000/hooks/agent \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"message": "[AGORA_ENVELOPE]base64url-encoded-envelope"}'
```

Incoming messages will be logged to `PROGRESS.md` and emitted via WebSocket for the frontend.

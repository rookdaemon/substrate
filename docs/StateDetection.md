# State Detection Fallback Mechanism

## Overview

The State Detection system provides a robust fallback mechanism for browser-based components to detect system state when direct file access is unavailable.

## Architecture

### Priority Chain

The system attempts state detection in the following order:

1. **API Endpoint** (`/api/state`) — Real-time, most accurate
2. **Environment Variables** (`VITE_SUBSTRATE_STATE_*`) — Build-time injection
3. **LocalStorage Cache** — Persisted from previous successful detection
4. **Default State** — Minimal fallback when all else fails

### Components

#### StateDetector Class

Core implementation in `client/src/environment/StateDetector.ts`

```typescript
import { stateDetector } from './environment';

// Detect current state
const state = await stateDetector.detectState();
console.log(state.agentName, state.mode, state.source);

// Cache state manually
stateDetector.cacheState(state);

// Clear cache
stateDetector.clearCache();
```

#### useSystemState Hook

React hook for automatic state management:

```typescript
import { useSystemState } from './hooks/useSystemState';

function MyComponent() {
  const { state, loading, error, refresh } = useSystemState(30000);
  
  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;
  
  return (
    <div>
      Agent: {state?.agentName || 'Unknown'}
      Mode: {state?.mode || 'Unknown'}
      Source: {state?.source}
      <button onClick={refresh}>Refresh</button>
    </div>
  );
}
```

### API Endpoint

**GET /api/state**

Returns current system state:

```json
{
  "agentName": "bishop",
  "mode": "cycle",
  "initialized": true
}
```

### Environment Variables

Configure at build time in `.env`:

```bash
VITE_SUBSTRATE_STATE_AGENT_NAME=bishop
VITE_SUBSTRATE_STATE_MODE=cycle
VITE_SUBSTRATE_STATE_INITIALIZED=true
```

### LocalStorage Cache

Automatically managed with 24-hour TTL. Cache key: `substrate_system_state`

## Usage Examples

### Simple Detection

```typescript
import { stateDetector } from './environment';

async function checkState() {
  const state = await stateDetector.detectState();
  
  if (state.initialized) {
    console.log(`System is running in ${state.mode} mode`);
  } else {
    console.log('System not initialized');
  }
  
  console.log(`State source: ${state.source}`);
}
```

### React Component with Auto-Refresh

```typescript
import { useSystemState } from './hooks/useSystemState';

function StatusIndicator() {
  // Auto-refresh every 30 seconds
  const { state, loading } = useSystemState(30000);
  
  return (
    <div className="status">
      <span className={state?.initialized ? 'active' : 'inactive'}>
        {state?.initialized ? '●' : '○'}
      </span>
      {state?.agentName}
    </div>
  );
}
```

### Disable Auto-Refresh

```typescript
// Pass 0 or negative value to disable auto-refresh
const { state, refresh } = useSystemState(0);

// Manual refresh only
<button onClick={refresh}>Refresh State</button>
```

## Error Handling

The system is designed to always return a valid state object, even on complete failure:

```typescript
// Even if all detection methods fail
const state = await stateDetector.detectState();
// state.source === "default"
// state.initialized === false
// state.timestamp === Date.now()
```

## Testing

Tests located in `client/tests/environment/StateDetector.test.ts`

Run tests:
```bash
npm test -- StateDetector
```

## Security Considerations

1. **API Token**: If `VITE_API_TOKEN` is configured, it's automatically included in API requests
2. **Cache Validation**: Cached data older than 24 hours is automatically discarded
3. **Error Privacy**: Errors are logged to console.debug, not exposed to users

## Performance

- **API Call**: ~50-200ms (network latency)
- **Environment Read**: <1ms (synchronous)
- **Cache Read**: <1ms (localStorage access)
- **Default Fallback**: <1ms (synchronous)

Auto-refresh impact: Minimal (single fetch every 30s by default)

## Migration Guide

### Before (Direct File Access)

```typescript
// Not possible in browser environment
const id = await readFile('/path/to/ID.md');
```

### After (Fallback Detection)

```typescript
import { useSystemState } from './hooks/useSystemState';

function Component() {
  const { state } = useSystemState();
  return <div>{state?.agentName}</div>;
}
```

## Troubleshooting

### State always returns "default"

1. Check API endpoint is accessible: `curl http://localhost:8080/api/state`
2. Verify environment variables are set correctly
3. Check browser localStorage is enabled
4. Review console for error messages

### Auto-refresh not working

1. Verify `refreshInterval` is positive number
2. Check component is still mounted
3. Verify no React strict mode issues

### Cache not persisting

1. Check browser localStorage quota
2. Verify localStorage is not disabled
3. Check for privacy/incognito mode

## Future Enhancements

- [ ] WebSocket support for real-time updates
- [ ] IndexedDB fallback for larger state data
- [ ] State change events/subscriptions
- [ ] Offline-first progressive enhancement

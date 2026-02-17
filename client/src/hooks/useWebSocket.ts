import { useState, useEffect, useRef, useCallback } from "react";

export interface LoopEvent {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export function useWebSocket(url: string) {
  const [lastEvent, setLastEvent] = useState<LoopEvent | null>(null);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const shouldReconnectRef = useRef(true);
  const manualReconnectRef = useRef(false);

  const INITIAL_RECONNECT_DELAY = 1000; // Start with 1 second
  const MAX_RECONNECT_DELAY = 30000; // Max 30 seconds between attempts

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const performConnect = useCallback(() => {
    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.onclose = null; // Prevent triggering reconnect
      wsRef.current.close();
    }

    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setReconnecting(false);
        reconnectAttemptsRef.current = 0; // Reset on successful connection
        manualReconnectRef.current = false;
      };

      ws.onclose = () => {
        setConnected(false);
        // Only auto-reconnect if we didn't manually close and should reconnect
        if (shouldReconnectRef.current && !manualReconnectRef.current) {
          // Schedule reconnect with exponential backoff
          clearReconnectTimer();
          const delay = Math.min(
            INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttemptsRef.current),
            MAX_RECONNECT_DELAY
          );
          setReconnecting(true);
          reconnectTimerRef.current = setTimeout(() => {
            reconnectAttemptsRef.current++;
            performConnect();
          }, delay);
        } else {
          setReconnecting(false);
        }
      };

      ws.onerror = () => {
        setConnected(false);
        // Error will be followed by onclose, which will handle reconnection
      };

      ws.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data);
          setLastEvent(parsed);
        } catch {
          // ignore non-JSON messages
        }
      };
    } catch {
      // Connection failed immediately
      setConnected(false);
      if (shouldReconnectRef.current) {
        // Schedule reconnect with exponential backoff
        clearReconnectTimer();
        const delay = Math.min(
          INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttemptsRef.current),
          MAX_RECONNECT_DELAY
        );
        setReconnecting(true);
        reconnectTimerRef.current = setTimeout(() => {
          reconnectAttemptsRef.current++;
          performConnect();
        }, delay);
      }
    }
  }, [url, clearReconnectTimer]);

  const reconnect = useCallback(() => {
    manualReconnectRef.current = true;
    reconnectAttemptsRef.current = 0; // Reset attempts for manual reconnect
    clearReconnectTimer();
    setReconnecting(true);
    performConnect();
  }, [performConnect, clearReconnectTimer]);

  useEffect(() => {
    shouldReconnectRef.current = true;
    performConnect();
    
    return () => {
      shouldReconnectRef.current = false;
      clearReconnectTimer();
      if (wsRef.current) {
        wsRef.current.onclose = null; // Prevent reconnect on cleanup
        wsRef.current.close();
      }
    };
  }, [performConnect, clearReconnectTimer]);

  return { lastEvent, connected, reconnecting, reconnect };
}

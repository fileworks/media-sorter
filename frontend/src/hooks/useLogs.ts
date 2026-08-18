import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/services/api";
import type { LogEntry } from "@/types/api";

const MAX_LOGS = 1000;
const RECONNECT_DELAY_MS = 3000;

export interface UseLogsReturn {
  logs: LogEntry[];
  isConnected: boolean;
  clear: () => void;
}

export function useLogs(): UseLogsReturn {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

  const connect = useCallback(() => {
    if (unmountedRef.current) return;

    // Both are `null` until the session resolves. Opening a socket against a
    // guessed `ws://127.0.0.1:8000` with the bare `mediasorter.` subprotocol —
    // which is what the old 200 ms timer raced towards — points the log stream
    // at whatever owns port 8000 on the user's machine.
    const url = api.getWebSocketUrl();
    const protocol = api.getWebSocketProtocol();
    if (url === null || protocol === null) {
      reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
      return;
    }

    const ws = new WebSocket(url, protocol);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!unmountedRef.current) setIsConnected(true);
    };

    ws.onmessage = (event: MessageEvent) => {
      if (unmountedRef.current) return;
      try {
        const entry = JSON.parse(event.data as string) as LogEntry;
        // Filter ping/heartbeat messages — never displayed
        if (entry.type === "ping") return;
        setLogs((prev) => {
          const next = [...prev, entry];
          return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
        });
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (unmountedRef.current) return;
      setIsConnected(false);
      // Re-connect after delay
      reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onerror = () => {
      // onclose fires right after onerror — close triggers the reconnect
      ws.close();
    };
  }, []);

  useEffect(() => {
    unmountedRef.current = false;

    // Await the resolved session rather than racing it. The old code waited
    // 200 ms and hoped; a hope is not a happens-before edge, and on a slow
    // start the socket opened against the dev fallback with an empty
    // capability. A startup failure is typed and handled — the stream simply
    // never connects, which is the honest outcome when there is no backend.
    void api
      .whenReady()
      .then(() => {
        if (!unmountedRef.current) connect();
      })
      .catch(() => {
        if (!unmountedRef.current) setIsConnected(false);
      });

    return () => {
      unmountedRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const clear = useCallback(() => setLogs([]), []);

  return { logs, isConnected, clear };
}

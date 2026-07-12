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

    // Resolve the WebSocket URL (uses the already-resolved baseURL after api.init,
    // or the built-in fallback of ws://127.0.0.1:8000/api/logs).
    const url = api.getWebSocketUrl();

    const ws = new WebSocket(url);
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

    // Delay the first connection slightly so api.init() has time to resolve the
    // backend port. The fallback (port 8000) is fine for dev mode, but this
    // avoids an extra failed connection attempt in unusual setups.
    const startTimer = setTimeout(connect, 200);

    return () => {
      unmountedRef.current = true;
      clearTimeout(startTimer);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const clear = useCallback(() => setLogs([]), []);

  return { logs, isConnected, clear };
}

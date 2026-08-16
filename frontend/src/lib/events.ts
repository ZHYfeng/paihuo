import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export type ConnectionState = "connecting" | "live" | "offline";

export function useEventStream() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<ConnectionState>("connecting");
  const [lastSync, setLastSync] = useState<Date | null>(null);

  useEffect(() => {
    const after = localStorage.getItem("paihuo:last-event-seq") || "0";
    const source = new EventSource(`/api/v1/events?after=${encodeURIComponent(after)}`);
    source.onopen = () => setState("live");
    source.onerror = () => setState("offline");
    const receive = (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(event.data);
        if (envelope.seq) localStorage.setItem("paihuo:last-event-seq", String(envelope.seq));
      } catch { /* invalid events are ignored and recovered by the next refetch */ }
      setLastSync(new Date());
      void queryClient.invalidateQueries();
    };
    ["task", "log", "session.updated", "session.message", "workflow.created", "workflow.run.started", "workflow.run.finished", "provision"].forEach(type => source.addEventListener(type, receive));
    return () => source.close();
  }, [queryClient]);

  return { state, lastSync };
}

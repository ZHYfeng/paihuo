import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button, Dialog } from "../ui";
import { api, keys } from "../../lib/api";
import type { RuntimeDescriptor } from "../../types";

export function InstallModal({ runtimeID, onClose }: { runtimeID: string; onClose(): void }) {
  const qc = useQueryClient();
  const runtimes = useQuery({ queryKey: keys.runtimes, queryFn: () => api<RuntimeDescriptor[]>("/runtimes") });
  const [lines, setLines] = useState<string[]>(["正在启动安装..."]);
  useEffect(() => {
    const source = new EventSource("/api/v1/events");
    const receive = (event: MessageEvent) => {
      try {
        const envelope = JSON.parse(event.data);
        const payload = envelope?.payload;
        if (payload?.runtime_id !== runtimeID) return;
        const line = String(payload?.line ?? "");
        setLines(prev => [...prev, line]);
        if (line.startsWith("[install]")) void qc.invalidateQueries({ queryKey: keys.runtimes });
      } catch { /* ignore malformed provision events */ }
    };
    source.addEventListener("provision", receive);
    source.onerror = () => { /* 事件流断开由页面级 useEventStream 恢复；此处仅接收安装输出 */ };
    return () => source.close();
  }, [runtimeID, qc]);
  const name = runtimes.data?.find(item => item.id === runtimeID)?.name || runtimeID;
  return <Dialog open onOpenChange={open => !open && onClose()} title={`安装 ${name}`} description="命令回显与执行输出由服务端经 SSE provision 事件实时推送。">
    <div className="rounded-xl border border-line bg-[#060a13] p-3">
      <div className="log-lines max-h-96" style={{ border: "none", padding: "0 4px", maxHeight: "24rem" }}>
        {lines.map((line, index) => <div key={index} className="line"><span className="ts" /><span className={line.startsWith("$") ? "c sys" : "c out"}>{line}</span></div>)}
      </div>
    </div>
    <div className="mt-4 flex justify-end"><Button onClick={onClose}>关闭</Button></div>
  </Dialog>;
}

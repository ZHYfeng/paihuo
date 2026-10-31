import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePlus, Copy, Download, RefreshCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeader } from "../../components/shell";
import { InstallModal } from "../../components/runtime/install-modal";
import { Badge, Button, Card, Spinner, useToast } from "../../components/ui";
import { api, keys } from "../../lib/api";
import type { ProvisionInfo, Role, RuntimeDescriptor } from "../../types";

export function RuntimesPage() {
  const runtimes = useQuery({ queryKey: keys.runtimes, queryFn: () => api<RuntimeDescriptor[]>("/runtimes") });
  const provisioning = useQuery({ queryKey: keys.provisioning, queryFn: () => api<ProvisionInfo[]>("/runtimes/provisioning") });
  const qc = useQueryClient();
  const toast = useToast();
  const [installing, setInstalling] = useState<string | null>(null);
  const refresh = useMutation({ mutationFn: () => api<RuntimeDescriptor[]>("/runtimes/refresh", { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: keys.runtimes }) });
  const install = useMutation({
    mutationFn: (runtime_id: string) => api("/runtimes/install", { method: "POST", body: { runtime_id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.provisioning }); },
    onError: error => toast((error as Error).message, "bad")
  });
  const startInstall = (runtimeID: string) => {
    setInstalling(runtimeID);
    install.mutate(runtimeID);
  };
  const byID = useMemo(() => new Map(provisioning.data?.map(item => [item.id, item])), [provisioning.data]);
  const createRole = useMutation({
    mutationFn: (provision: ProvisionInfo) => api<Role>("/roles", { method: "POST", body: { name: provision.name, description: `基于 ${provision.name} CLI 的默认角色`, runtime_id: provision.id, max_concurrency: 1, enabled: true, role_config: {} } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: keys.roles }); toast("已创建角色，可在角色页继续定制"); },
    onError: error => toast((error as Error).message, "bad")
  });
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制");
    } catch {
      toast("复制失败", "bad");
    }
  };
  return <>
    <PageHeader title="运行环境" copy="管理本机的执行提供者，检查安装、登录与可用能力。" actions={<Button onClick={() => refresh.mutate()} disabled={refresh.isPending}><RefreshCcw size={16} />刷新模型与健康状态</Button>} />
    <div className="mb-4 text-sm text-muted">已安装 {provisioning.data?.filter(p => p.installed).length || 0}/{provisioning.data?.length || 0}</div>
    {runtimes.isLoading ? <Spinner /> : <div className="grid gap-3 lg:grid-cols-2">{runtimes.data?.map(runtime => { const provision = byID.get(runtime.id); return <Card key={runtime.id}>
      <div className="flex items-start gap-3"><div><div className="flex items-center gap-2"><h2 className="font-semibold">{runtime.name}</h2><Badge tone={runtime.healthy ? "good" : "bad"}>{runtime.healthy ? "可用" : "不可用"}</Badge></div><a className="mt-1 block text-xs text-brand-soft hover:underline" href={runtime.docs} target="_blank" rel="noreferrer">官方文档 ↗</a></div>{provision?.version ? <span className="ml-auto text-sm text-faint">{provision.version}</span> : null}</div>
      {runtime.health && <p className="mt-3 text-sm text-muted">{runtime.health}</p>}
      {provision ? <div className="mt-3 rounded-xl border border-line bg-elevated px-3 py-2 text-xs">
        {provision.installed
          ? provision.login
            ? <p className="text-success">已检测到登录凭据 ✓</p>
            : <p className="text-warning">{provision.login_hint || "请在服务器终端完成登录"}</p>
          : <p className="font-mono text-muted" title="官方安装命令">$ {provision.install_cmd || "（请参考官方文档）"}</p>}
      </div> : null}
      <div className="mt-3 flex flex-wrap gap-2">{runtime.capabilities.map(cap => <Badge key={cap} tone="info">{cap}</Badge>)}</div>
      <div className="mt-3 text-xs text-muted">{runtime.models?.length || 0} 个可用模型 · {runtime.fields.length} 个配置字段</div>
      <div className="mt-3 flex flex-wrap gap-2">
        {provision && !provision.installed ? <Button size="sm" variant="primary" onClick={() => startInstall(runtime.id)}><Download size={15} />安装</Button> : null}
        {provision && provision.installed ? <Button size="sm" onClick={() => startInstall(runtime.id)}><RefreshCcw size={14} />重装/更新</Button> : null}
        {provision && provision.installed && provision.login_hint ? <Button size="sm" variant="ghost" onClick={() => void copyText(provision.login_hint)}><Copy size={14} />复制登录指引</Button> : null}
        {provision && provision.installed ? <Button size="sm" variant="ghost" onClick={() => { const name = prompt(`创建基于 ${runtime.name} 的默认角色名称`, runtime.name); if (name) createRole.mutate({ ...provision, name }); }}><CirclePlus size={14} />创建默认角色</Button> : null}
      </div>
    </Card>; })}</div>}
    {installing && <InstallModal runtimeID={installing} onClose={() => setInstalling(null)} />}
  </>;
}

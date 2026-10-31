import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CirclePlus, Copy, Download, RefreshCcw } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeader } from "../../components/shell";
import { InstallModal } from "../../components/runtime/install-modal";
import { Badge, Button, Card, Spinner, inputClass, useToast } from "../../components/ui";
import { api, keys } from "../../lib/api";
import { credentialLabel } from "../../lib/runtime-auth";
import type { Project, ProvisionInfo, Role, RuntimeDescriptor, RuntimeSkillInventory } from "../../types";

export function RuntimesPage() {
  const runtimes = useQuery({ queryKey: keys.runtimes, queryFn: () => api<RuntimeDescriptor[]>("/runtimes") });
  const provisioning = useQuery({ queryKey: keys.provisioning, queryFn: () => api<ProvisionInfo[]>("/runtimes/provisioning") });
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api<Project[]>("/projects") });
  const [projectID, setProjectID] = useState("");
  const qc = useQueryClient();
  const toast = useToast();
  const [installing, setInstalling] = useState<string | null>(null);
  const refresh = useMutation({ mutationFn: () => api<RuntimeDescriptor[]>("/runtimes/refresh", { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: keys.runtimes }), onError: error => toast((error as Error).message, "bad") });
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
    <PageHeader title="运行环境" copy="检查本机执行提供者的安装、凭据与原生技能。" actions={<Button onClick={() => refresh.mutate()} disabled={refresh.isPending}><RefreshCcw size={16} />刷新检测</Button>} />
    <div className="mb-4 flex flex-wrap items-center gap-3 text-sm text-muted"><span>已安装 {provisioning.data?.filter(p => p.installed).length || 0}/{provisioning.data?.length || 0}</span><label className="ml-auto flex items-center gap-2">技能范围<select aria-label="技能范围" className={inputClass} value={projectID} onChange={e => setProjectID(e.target.value)}><option value="">本机用户技能</option>{projects.data?.map(project => <option key={project.id} value={project.id}>{project.name} · 包含项目技能</option>)}</select></label></div>
    {provisioning.isError && <p className="mb-3 text-sm text-danger">凭据检测暂时无法加载，请重试。</p>}
    {runtimes.isLoading ? <Spinner /> : <div className="grid gap-3 lg:grid-cols-2">{runtimes.data?.map(runtime => { const provision = byID.get(runtime.id); return <Card key={runtime.id}>
      <div className="flex items-start gap-3"><div><div className="flex items-center gap-2"><h2 className="font-semibold">{runtime.name}</h2><Badge tone={runtime.healthy ? "good" : "bad"}>{runtime.healthy ? "可用" : "不可用"}</Badge></div><a className="mt-1 block text-xs text-brand-soft hover:underline" href={runtime.docs} target="_blank" rel="noreferrer">官方文档 ↗</a></div>{provision?.version ? <span className="ml-auto text-sm text-faint">{provision.version}</span> : null}</div>
      {runtime.health && <p className="mt-3 text-sm text-muted">{runtime.health}</p>}
      {provision ? <div className="mt-3 rounded-xl border border-line bg-elevated px-3 py-2 text-xs">
        {provision.installed
          ? <><p className={provision.auth?.status === "authenticated" ? "text-success" : "text-muted"}>{provision.auth?.message || credentialLabel(provision)}</p>{provision.auth?.source && <p className="mt-1 break-all text-faint">来源：{provision.auth.source}</p>}{!provision.login && <p className="mt-1 text-warning">{provision.login_hint || "请在服务器终端完成登录"}</p>}</>
          : <p className="font-mono text-muted" title="官方安装命令">$ {provision.install_cmd || "（请参考官方文档）"}</p>}
      </div> : null}
      <div className="mt-3 flex flex-wrap gap-2">{runtime.capabilities.map(cap => <Badge key={cap} tone="info">{cap}</Badge>)}</div>
      <div className="mt-3 text-xs text-muted">{runtime.models?.length || 0} 个可用模型 · {runtime.fields.length} 个配置字段</div>
      <RuntimeSkills runtimeID={runtime.id} projectID={projectID} />
      <div className="mt-3 flex flex-wrap gap-2">
        {provision && !provision.installed ? <Button size="sm" variant="primary" onClick={() => startInstall(runtime.id)}><Download size={15} />安装</Button> : null}
        {provision && provision.installed ? <Button size="sm" onClick={() => startInstall(runtime.id)}><RefreshCcw size={14} />重装/更新</Button> : null}
        {provision && provision.installed && provision.login_hint ? <Button size="sm" variant="ghost" onClick={() => void copyText(provision.login_hint)}><Copy size={14} />复制登录指引</Button> : null}
        {provision && provision.installed ? <Button size="sm" variant="ghost" onClick={() => { const name = prompt(`创建基于 ${runtime.name} 的默认角色名称`, runtime.name); if (name) createRole.mutate({ ...provision, name }); }}><CirclePlus size={14} />创建默认角色</Button> : null}
      </div>
    </Card>; })}</div>}
    {installing && <InstallModal runtimeID={installing} onClose={() => { setInstalling(null); void qc.invalidateQueries({ queryKey: keys.runtimes }); }} />}
  </>;
}

function RuntimeSkills({ runtimeID, projectID }: { runtimeID: string; projectID: string }) {
  const inventory = useQuery({
    queryKey: [...keys.runtimes, "skills", runtimeID, projectID],
    queryFn: () => api<RuntimeSkillInventory>(`/runtimes/${runtimeID}/skills${projectID ? `?project_id=${projectID}` : ""}`)
  });
  const scope: Record<string, string> = { user: "用户", project: "项目", plugin: "插件", package: "包", preset: "预设", custom: "自定义", admin: "管理员", system: "内置", repo: "项目" };
  return <div className="mt-3 border-t border-line pt-3 text-xs">
    {inventory.isLoading ? <p className="text-muted">正在检测原生技能…</p> : inventory.isError ? <p className="text-danger">技能检测失败，请刷新重试。</p> : inventory.data && <>
      {inventory.data.warnings.map((warning, i) => <p key={i} className="mb-2 text-warning">{warning}</p>)}
      <details><summary className="cursor-pointer text-muted">发现 {inventory.data.skills?.length || 0} 项原生技能{!inventory.data.complete ? " · 检测不完整" : ""}</summary>
        <ul className="mt-2 grid max-h-72 gap-2 overflow-y-auto">{inventory.data.skills?.map(skill => <li key={skill.path} className="rounded-lg border border-line bg-elevated p-2">
          <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-ink">{skill.name}</span><Badge>{scope[skill.scope.toLowerCase()] || skill.scope}</Badge><Badge tone={skill.enabled === true ? "good" : "neutral"}>{skill.enabled === true ? "已启用" : skill.enabled === false ? "未加载" : "加载状态未知"}</Badge></div>
          {skill.description && <p className="mt-1 text-muted">{skill.description}</p>}<p className="mt-1 break-all text-faint">{skill.source} · {skill.path}</p>
        </li>)}</ul>
        {!inventory.data.skills?.length && <p className="mt-2 text-faint">当前范围未发现原生技能。</p>}
      </details>
    </>}
  </div>;
}

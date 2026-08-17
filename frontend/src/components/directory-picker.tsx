// 目录选择器：浏览服务器文件系统（GET /fs/dirs），支持新建子目录（POST /fs/mkdir）。
// 自旧前端 projects.js 的 dirModal 一比一移植，供项目/技能路径字段共用。
import { useEffect, useState } from "react";
import { Folder, FolderOpen } from "lucide-react";
import { api } from "../lib/api";
import { Button, Dialog, inputClass, useToast } from "./ui";

interface DirListing { path: string; parent: string; dirs: string[] }

export function DirectoryPicker({ open, onOpenChange, initial, onPick }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  initial?: string;
  onPick(path: string): void;
}) {
  const toast = useToast();
  const [listing, setListing] = useState<DirListing | null>(null);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<DirListing>(`/fs/dirs?path=${encodeURIComponent(initial?.trim() || "")}`)
      .then(data => { if (!cancelled) { setListing(data); setError(""); setNewName(""); } })
      .catch(err => { if (!cancelled) { setError((err as Error).message); setListing(null); } });
    return () => { cancelled = true; };
  }, [open, initial]);

  const load = async (path: string) => {
    setError("");
    try {
      setListing(await api<DirListing>(`/fs/dirs?path=${encodeURIComponent(path)}`));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const mkdir = async () => {
    const name = newName.trim();
    if (!name) return;
    if (!listing) return;
    setCreating(true);
    setError("");
    try {
      await api("/fs/mkdir", { method: "POST", body: { path: `${listing.path.replace(/\/+$/, "")}/${name}` } });
      setNewName("");
      toast("已创建目录");
      await load(listing.path);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const crumbs: Array<{ label: string; path: string; last: boolean }> = [];
  if (listing) {
    const segs = listing.path.split("/").filter(Boolean);
    let cur = "";
    segs.forEach((seg, i) => {
      cur += "/" + seg;
      crumbs.push({ label: seg, path: cur, last: i === segs.length - 1 });
    });
  }

  return <Dialog open={open} onOpenChange={onOpenChange} title="选择目录" description="浏览服务器文件系统">
    <div className="grid gap-3">
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <nav className="flex flex-wrap items-center gap-1 rounded-xl border border-line bg-elevated px-3 py-2 text-sm" aria-label="当前路径">
        <button type="button" className="rounded-lg px-2 py-1 text-muted hover:bg-hover hover:text-ink" onClick={() => load("/")}>/</button>
        {crumbs.map(crumb => <span key={crumb.path} className="flex items-center gap-1"><span className="text-faint">/</span>{crumb.last ? <span className="rounded-lg bg-brand/10 px-2 py-1 font-medium text-brand-soft" aria-current="location">{crumb.label}</span> : <button type="button" className="rounded-lg px-2 py-1 text-muted hover:bg-hover hover:text-ink" onClick={() => load(crumb.path)}>{crumb.label}</button>}</span>)}
      </nav>
      <div className="grid max-h-72 gap-1 overflow-auto rounded-xl border border-line bg-elevated p-2">
        {listing && listing.parent !== listing.path && <button type="button" className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-muted hover:bg-hover hover:text-ink" onClick={() => load(listing.parent)}><FolderOpen size={15} className="shrink-0" aria-hidden="true" />上一级</button>}
        {listing?.dirs?.map(dir => <button type="button" key={dir} className="flex items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink hover:bg-hover" onClick={() => load(`${listing.path.replace(/\/+$/, "")}/${dir}`)}>
          <Folder size={15} className="shrink-0 text-brand-soft" aria-hidden="true" />{dir}
        </button>)}
        {listing && !listing.dirs?.length && listing.parent === listing.path && <p className="px-3 py-4 text-center text-sm text-faint">空目录</p>}
      </div>
      <div className="flex gap-2">
        <input className={inputClass} placeholder="在当前目录下新建子目录名" value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void mkdir(); } }} aria-label="新建子目录名" />
        <Button type="button" disabled={!newName.trim() || creating} onClick={() => void mkdir()}>创建</Button>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
        <Button variant="primary" disabled={!listing} onClick={() => { if (listing) { onPick(listing.path); onOpenChange(false); toast("已选择目录"); } }}>使用此目录</Button>
      </div>
    </div>
  </Dialog>;
}

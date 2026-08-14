import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

export function Button({ variant = "secondary", size = "md", className, ...props }: ButtonProps) {
  return <button {...props} className={cn(
    "inline-flex min-h-8 items-center justify-center gap-2 whitespace-nowrap rounded-lg border px-3 text-sm font-medium transition-colors duration-150",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas",
    "disabled:pointer-events-none disabled:opacity-45",
    size === "sm" ? "min-h-7 px-2.5 text-[13px]" : "",
    variant === "primary" && "border-transparent bg-brand text-white hover:bg-brand-strong active:translate-y-px",
    variant === "secondary" && "border-line bg-surface text-ink hover:border-brand/40 hover:bg-hover active:translate-y-px",
    variant === "ghost" && "border-transparent bg-transparent text-muted hover:bg-hover hover:text-ink",
    variant === "danger" && "border-danger/30 bg-danger/10 text-danger hover:bg-danger/20 hover:border-danger/45",
    className
  )} />;
}

export function Dialog({ open, onOpenChange, title, description, children, wide = false }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm data-[state=open]:animate-in" />
      <DialogPrimitive.Content className={cn(
        "fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border border-line bg-surface p-4 shadow-pop",
        "focus:outline-none", wide ? "max-w-5xl" : "max-w-xl"
      )}>
        <DialogPrimitive.Title className="pr-8 text-lg font-bold tracking-tight text-ink">{title}</DialogPrimitive.Title>
        {description && <DialogPrimitive.Description className="mt-1 text-sm leading-6 text-muted">{description}</DialogPrimitive.Description>}
        <DialogPrimitive.Close className="absolute right-3 top-3 grid size-8 place-items-center rounded-md text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus" aria-label="关闭">
          <X size={16} />
        </DialogPrimitive.Close>
        <div className="mt-3">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  </DialogPrimitive.Root>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="grid gap-1 text-sm font-medium text-ink">
    <span>{label}</span>
    {children}
    {hint && <span className="text-xs font-normal leading-5 text-muted">{hint}</span>}
  </label>;
}

export const inputClass = "min-h-9 w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink outline-none transition-[border-color,box-shadow] placeholder:text-faint hover:border-muted/50 focus:border-brand focus:ring-4 focus:ring-brand/15";

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "warn" | "bad" | "info" }) {
  return <span className={cn(
    "inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium",
    tone === "neutral" && "border-line bg-elevated text-muted",
    tone === "good" && "border-success/25 bg-success/10 text-success",
    tone === "warn" && "border-warning/25 bg-warning/10 text-warning",
    tone === "bad" && "border-danger/25 bg-danger/10 text-danger",
    tone === "info" && "border-brand/25 bg-brand/10 text-brand-soft"
  )}>{children}</span>;
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn("rounded-xl border border-line bg-surface p-3.5 shadow-card", className)}>{children}</section>;
}

export function Empty({ title, copy, action }: { title: string; copy: string; action?: React.ReactNode }) {
  return <div className="grid min-h-32 place-items-center rounded-xl border border-dashed border-line bg-surface/60 p-5 text-center">
    <div><h3 className="font-semibold text-ink">{title}</h3><p className="mt-1.5 max-w-md text-sm leading-6 text-muted">{copy}</p>{action && <div className="mt-3">{action}</div>}</div>
  </div>;
}

export function Spinner({ label = "加载中" }: { label?: string }) {
  return <div className="flex min-h-24 items-center justify-center gap-3 text-sm text-muted" role="status">
    <span className="size-5 animate-spin rounded-full border-2 border-line border-t-brand motion-reduce:animate-none" />{label}
  </div>;
}

type Toast = { id: number; message: string; tone: "good" | "bad" };
const ToastContext = createContext<(message: string, tone?: Toast["tone"]) => void>(() => undefined);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast["tone"] = "good") => {
    const id = Date.now() + Math.random();
    setToasts(current => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts(current => current.filter(item => item.id !== id)), 4000);
  }, []);
  const value = useMemo(() => push, [push]);
  return <ToastContext.Provider value={value}>
    {children}
    <div className="fixed bottom-5 right-5 z-[70] grid w-[min(24rem,calc(100%-2rem))] gap-2" aria-live="polite" aria-atomic="true">
      {toasts.map(toast => <div key={toast.id} className={cn("flex items-start gap-2.5 rounded-xl border bg-surface/95 px-4 py-3 text-sm shadow-pop backdrop-blur", toast.tone === "bad" ? "border-danger/35 text-danger" : "border-success/35 text-ink")}>
        <span className={cn("mt-1 size-2 shrink-0 rounded-full", toast.tone === "bad" ? "bg-danger" : "bg-success")} aria-hidden="true" />
        <span className="min-w-0 break-words">{toast.message}</span>
      </div>)}
    </div>
  </ToastContext.Provider>;
}

export function useToast() { return useContext(ToastContext); }

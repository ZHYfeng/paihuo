import { Field, inputClass } from "../ui";

const SCHED_WEEKDAYS = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
export const SCHED_DEFAULT_TIME = "09:00";

// 调度器保存六段 cron；表单只映射常用周期。兼容五段与六段。
export function parseScheduleCron(cron: string): { frequency: string; weekday?: string; monthday?: string; time?: string } | null {
  const raw = String(cron || "").trim().toLowerCase();
  if (raw === "@daily") return { frequency: "daily", time: "00:00" };
  if (raw === "@weekly") return { frequency: "weekly", weekday: "7", time: "00:00" };
  if (raw === "@monthly") return { frequency: "monthly", monthday: "1", time: "00:00" };
  const fields = raw.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return null;
  const [second, minute, hour, dom, month, dow] = fields.length === 6 ? fields : ["0", fields[0], fields[1], fields[2], fields[3], fields[4]];
  if (second !== "0" || month !== "*") return null;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  const minuteNum = Number(minute), hourNum = Number(hour);
  if (minuteNum < 0 || minuteNum > 59 || hourNum < 0 || hourNum > 23) return null;
  const time = `${String(hourNum).padStart(2, "0")}:${String(minuteNum).padStart(2, "0")}`;
  if (dom === "*" && dow === "*") return { frequency: "daily", time };
  if (dom === "*" && dow === "1-5") return { frequency: "weekdays", time };
  if (dom === "*" && /^\d$/.test(dow) && Number(dow) >= 0 && Number(dow) <= 7) {
    return { frequency: "weekly", weekday: String(Number(dow) === 0 ? 7 : Number(dow)), time };
  }
  if (dow === "*" && /^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
    return { frequency: "monthly", monthday: String(Number(dom)), time };
  }
  return null;
}

export function scheduleLabel(cron: string): string {
  const parsed = parseScheduleCron(cron);
  if (!parsed) return "自定义周期";
  if (parsed.frequency === "daily") return `每天 ${parsed.time}`;
  if (parsed.frequency === "weekdays") return `工作日 ${parsed.time}`;
  if (parsed.frequency === "weekly") return `每周${SCHED_WEEKDAYS[Number(parsed.weekday)] || ""} ${parsed.time}`;
  if (parsed.frequency === "monthly") return `每月${parsed.monthday}日 ${parsed.time}`;
  return "自定义周期";
}

export function cronFromFields(frequency: string, weekday: string, monthday: string, time: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return "";
  const minute = Number(match[2]);
  const hour = Number(match[1]);
  let dom = "*", dow = "*";
  if (frequency === "weekdays") dow = "1-5";
  if (frequency === "weekly") {
    const day = Number(weekday) || 1;
    dow = day === 7 ? "0" : String(day);
  }
  if (frequency === "monthly") dom = String(Number(monthday) || 1);
  return `0 ${minute} ${hour} ${dom} * ${dow}`;
}

export function ScheduleCronFields({ value, onChange }: { value: { frequency: string; weekday: string; monthday: string; time: string }; onChange(patch: Partial<typeof value>): void }) {
  const cron = cronFromFields(value.frequency, value.weekday, value.monthday, value.time);
  return <div className="grid gap-4">
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="周期"><select className={inputClass} value={value.frequency} onChange={e => onChange({ frequency: e.target.value })}><option value="daily">每天</option><option value="weekdays">工作日</option><option value="weekly">每周</option><option value="monthly">每月</option></select></Field>
      <Field label="时间"><input type="time" className={inputClass} value={value.time} onChange={e => onChange({ time: e.target.value })} /></Field>
    </div>
    {value.frequency === "weekly" ? <Field label="星期"><select className={inputClass} value={value.weekday} onChange={e => onChange({ weekday: e.target.value })}>{SCHED_WEEKDAYS.slice(1).map((label, index) => <option key={index + 1} value={index + 1}>{label}</option>)}</select></Field> : value.frequency === "monthly" ? <Field label="日期"><select className={inputClass} value={value.monthday} onChange={e => onChange({ monthday: e.target.value })}>{Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} 日</option>)}</select></Field> : null}
    <p className="rounded-xl bg-elevated px-3 py-2 text-sm text-muted">将按“{scheduleLabel(cron)}”执行{cron ? <code className="ml-1 text-[11px] text-faint">{cron}</code> : null}</p>
  </div>;
}

// ScheduleToggle 是定时属性（正交）的开关：勾选后本任务变为定时定义，到点
// 由调度器按形态创建实例，本定义永不直接执行。
export function ScheduleToggle({ checked, onChange, enabled, onEnabledChange, cronForm, onCronChange }: {
  checked: boolean;
  onChange(checked: boolean): void;
  enabled: boolean;
  onEnabledChange(enabled: boolean): void;
  cronForm: { frequency: string; weekday: string; monthday: string; time: string };
  onCronChange(patch: Partial<typeof cronForm>): void;
}) {
  return <div className="grid gap-3 rounded-xl border border-line bg-elevated p-3">
    <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />定时执行（到点自动创建实例；本任务作为定时定义，永不直接执行）</label>
    {checked && <>
      <ScheduleCronFields value={cronForm} onChange={onCronChange} />
      <label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={enabled} onChange={e => onEnabledChange(e.target.checked)} />启用</label>
    </>}
  </div>;
}

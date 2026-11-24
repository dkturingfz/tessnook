// 截止日期提醒的派生数据：根据当前数据与个人偏好实时计算，跨过零点自动刷新。
import { useEffect, useMemo, useState } from 'react';
import type { ID, Task } from '../domain/types';
import { deadlineAlert, localDate, type DeadlineAlert } from '../domain/deadlines';
import { useStore } from './store';

/** 当前本地日期；跨过零点或页面重新可见时更新 */
export function useToday(): string {
  const [today, setToday] = useState(localDate);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
      timer = setTimeout(() => { setToday(localDate()); schedule(); }, next.getTime() - now.getTime());
    };
    schedule();
    const refresh = () => setToday(localDate());
    document.addEventListener('visibilitychange', refresh);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return today;
}

/** 工作空间内所有未被“暂不提醒”的提醒，按事件包 id 索引 */
export function useAlerts(): Map<ID, DeadlineAlert> {
  const events = useStore((s) => s.events);
  const tasks = useStore((s) => s.tasks);
  const regions = useStore((s) => s.regions);
  const leadDays = useStore((s) => s.leadDays);
  const snoozed = useStore((s) => s.snoozed);
  const today = useToday();
  return useMemo(() => {
    const byEvent = new Map<ID, Task[]>();
    for (const t of Object.values(tasks)) byEvent.set(t.event_id, [...(byEvent.get(t.event_id) ?? []), t]);
    const skip = new Set(snoozed);
    const out = new Map<ID, DeadlineAlert>();
    for (const e of Object.values(events)) {
      const a = deadlineAlert(e, byEvent.get(e.id) ?? [], e.region_id ? regions[e.region_id] : null, today, leadDays);
      if (a && !skip.has(a.key)) out.set(e.id, a);
    }
    return out;
  }, [events, tasks, regions, leadDays, snoozed, today]);
}

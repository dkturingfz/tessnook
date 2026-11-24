// 截止日期提醒：纯函数，在客户端根据当前数据实时计算，不需要后端或定时任务。
// 只给出建议，不自动移动卡片（卡片位置是团队共享的布局，应由人决定）。
import type { EventPkg, Quadrant, Region, Task } from './types';
import { axesOf } from './axes';
import { regionBody, type Point } from './layout';

export const LEAD_DAY_OPTIONS = [1, 3, 7] as const;
export type LeadDays = (typeof LEAD_DAY_OPTIONS)[number];
export const DEFAULT_LEAD_DAYS: LeadDays = 3;

/** 不紧急象限 → 同一行的紧急象限（横轴向右为更紧急） */
export const ESCALATE_TO: Partial<Record<Quadrant, Quadrant>> = { Q2: 'Q1', Q3: 'Q4' };

export interface EffectiveDue {
  date: string; // YYYY-MM-DD
  source: 'event' | 'task';
  taskTitle?: string;
}

export interface DeadlineAlert {
  kind: 'overdue' | 'escalate';
  eventId: string;
  due: EffectiveDue;
  /** 距截止的天数；负数表示已逾期 */
  daysLeft: number;
  /** escalate 时的建议目标象限 */
  target?: Quadrant;
  /** 用于“暂不提醒”的键：截止日期或提醒类型变化后会重新提醒 */
  key: string;
}

/** 本地日期 YYYY-MM-DD */
export function localDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 两个 YYYY-MM-DD 日期之间相差的天数（与时区无关） */
export function daysBetween(from: string, to: string): number {
  const utc = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(to) - utc(from)) / 86400_000);
}

/** 事件包的有效截止日期 = 事件包自身与其未完成任务的截止日期中最早的一个 */
export function effectiveDue(e: Pick<EventPkg, 'due_date'>, tasks: Pick<Task, 'due_date' | 'done' | 'title'>[]): EffectiveDue | null {
  let best: EffectiveDue | null = e.due_date ? { date: e.due_date, source: 'event' } : null;
  for (const t of tasks) {
    if (t.done || !t.due_date) continue;
    if (!best || t.due_date < best.date) best = { date: t.due_date, source: 'task', taskTitle: t.title };
  }
  return best;
}

export function deadlineAlert(
  e: EventPkg,
  tasks: Pick<Task, 'due_date' | 'done' | 'title'>[],
  region: Pick<Region, 'template' | 'axis_config'> | null | undefined,
  today: string,
  leadDays: number,
): DeadlineAlert | null {
  if (e.status === 'completed' || e.archived_at) return null;
  const due = effectiveDue(e, tasks);
  if (!due) return null;
  const daysLeft = daysBetween(today, due.date);
  if (daysLeft < 0) return { kind: 'overdue', eventId: e.id, due, daysLeft, key: `${e.id}:overdue:${due.date}` };
  const target = e.quadrant ? ESCALATE_TO[e.quadrant] : undefined;
  if (target && region && e.region_id && axesOf(region).urgencyX && daysLeft <= leadDays) {
    return { kind: 'escalate', eventId: e.id, due, daysLeft, target, key: `${e.id}:escalate:${due.date}` };
  }
  return null;
}

/** 升级位置：同一高度，平移到右侧紧急象限的对应位置（左右两半之间平移半个区域宽度） */
export function escalatePosition(p: Point, region: Pick<Region, 'x' | 'y' | 'width' | 'height'>): Point {
  const body = regionBody(region as Region);
  return { x: Math.round(p.x + body.width / 2), y: p.y };
}

/** 提醒的文字说明，例如 “3 天后截止（任务「写 PPT」）” */
export function describeDue(a: Pick<DeadlineAlert, 'daysLeft' | 'due'>): string {
  const when = a.daysLeft < 0 ? `已逾期 ${-a.daysLeft} 天` : a.daysLeft === 0 ? '今天截止' : a.daysLeft === 1 ? '明天截止' : `${a.daysLeft} 天后截止`;
  return a.due.source === 'task' ? `${when}（任务「${a.due.taskTitle}」）` : when;
}

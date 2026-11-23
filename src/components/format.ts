export function initials(name: string) {
  const n = name.trim();
  if (!n) return '?';
  return /[一-龥]/.test(n[0]) ? n.slice(-1) : n.slice(0, 2).toUpperCase();
}

export function formatDue(d: string) {
  const date = new Date(d + 'T00:00:00');
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function dueState(d: string | null, done: boolean): 'none' | 'overdue' | 'soon' | 'later' {
  if (!d || done) return 'none';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = (new Date(d + 'T00:00:00').getTime() - today.getTime()) / 86400_000;
  if (diff < 0) return 'overdue';
  if (diff <= 2) return 'soon';
  return 'later';
}

export function relTime(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

export const EVENT_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];

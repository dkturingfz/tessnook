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

/** 头像配色：取自品牌色的加深版本，每种颜色与白色文字的对比度都 ≥ 4.5（见 tests/format.test.ts） */
export const AVATAR_COLORS = ['#3E7C73', '#557799', '#7D68A0', '#9B6B3D', '#4D6B66', '#8A5A7A', '#5C7C49', '#46617F'];
export function avatarColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** 事件包的强调色：自定义颜色优先，否则使用所在象限的品牌色 */
export function eventAccent(color: string | null, quadrant: string | null) {
  if (color) return color;
  return quadrant ? `var(--${quadrant.toLowerCase()}-solid)` : 'var(--accent-default)';
}

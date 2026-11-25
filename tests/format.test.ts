import { describe, expect, it } from 'vitest';
import { AVATAR_COLORS, DEFAULT_TITLE, avatarColor, pageTitle } from '../src/components/format';

const lum = (h: string) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe('头像配色', () => {
  it('每种颜色与白色文字的对比度都满足 WCAG AA（≥ 4.5）', () => {
    for (const c of AVATAR_COLORS) expect(contrast(c, '#ffffff'), c).toBeGreaterThanOrEqual(4.5);
  });
  it('同一用户总是得到同一种颜色', () => {
    expect(avatarColor('user-1')).toBe(avatarColor('user-1'));
    expect(AVATAR_COLORS).toContain(avatarColor('another'));
  });
});

describe('浏览器标签页标题', () => {
  it('未进入工作空间时为默认标题', () => {
    expect(pageTitle({})).toBe(DEFAULT_TITLE);
  });
  it('工作空间、打开的事件包与提醒数量', () => {
    expect(pageTitle({ workspace: '课题组' })).toBe('课题组 · Tessnook');
    expect(pageTitle({ workspace: '课题组', event: '写论文' })).toBe('写论文 · 课题组 · Tessnook');
    expect(pageTitle({ workspace: '课题组', event: '写论文', alerts: 2 })).toBe('(2) 写论文 · 课题组 · Tessnook');
    expect(pageTitle({ workspace: '课题组', alerts: 120 })).toBe('(99+) 课题组 · Tessnook');
    expect(pageTitle({ workspace: '课题组', event: '  ' })).toBe('课题组 · Tessnook');
  });
});

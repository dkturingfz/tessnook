import { describe, expect, it } from 'vitest';
import {
  EVENT_W, GRID_GAP, cardCenter, fanOut, gridArrange, locate, positionBetween, quadrantOf, quadrantRect, REGION_HEADER_H, scaleWithRegion,
} from '../src/domain/layout';
import type { Region } from '../src/domain/types';

const region = (over: Partial<Region> = {}): Region => ({
  id: 'r1', workspace_id: 'w', version: 1, created_at: '', updated_at: '',
  name: 'R', x: 0, y: 0, width: 1000, height: 800 + REGION_HEADER_H, ...over,
});

describe('象限判定', () => {
  const r = region();
  it('右上为 Q1（重要且紧急），左上 Q2，左下 Q3，右下 Q4', () => {
    expect(quadrantOf(r, { x: 900, y: 100 })).toBe('Q1');
    expect(quadrantOf(r, { x: 100, y: 100 })).toBe('Q2');
    expect(quadrantOf(r, { x: 100, y: 700 })).toBe('Q3');
    expect(quadrantOf(r, { x: 900, y: 700 })).toBe('Q4');
  });
  it('区域外的点不归属任何象限；嵌套时优先最小区域', () => {
    const inner = region({ id: 'r2', x: 600, y: 100, width: 300, height: 300 });
    expect(locate([r], { x: 2000, y: 2000 })).toEqual({ region_id: null, quadrant: null });
    expect(locate([r, inner], { x: 700, y: 200 }).region_id).toBe('r2');
    expect(locate([r, inner], { x: 100, y: 200 }).region_id).toBe('r1');
  });
  it('标题栏不属于区域主体', () => {
    expect(locate([r], { x: 100, y: 10 }).region_id).toBeNull();
  });
  it('quadrantRect 与 quadrantOf 一致', () => {
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4'] as const) {
      const rect = quadrantRect(r, q);
      expect(quadrantOf(r, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })).toBe(q);
    }
  });
  it('卡片中心用于判定', () => {
    expect(cardCenter({ x: 0, y: 0 }).x).toBe(EVENT_W / 2);
  });
});

describe('网格整理', () => {
  it('按阅读顺序排成指定列数，不重叠', () => {
    const items = [
      { id: 'c', x: 500, y: 10 }, { id: 'a', x: 0, y: 0 }, { id: 'b', x: 300, y: 20 }, { id: 'd', x: 0, y: 400 },
    ];
    const out = gridArrange(items, { x: 100, y: 100 }, { availableWidth: 2 * EVENT_W + GRID_GAP, rowHeight: 100 });
    expect(out.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(out[0]).toMatchObject({ x: 100, y: 100 });
    expect(out[1]).toMatchObject({ x: 100 + EVENT_W + GRID_GAP, y: 100 });
    expect(out[2]).toMatchObject({ x: 100, y: 100 + 100 + GRID_GAP });
    const keys = new Set(out.map((o) => `${o.x},${o.y}`));
    expect(keys.size).toBe(4);
  });
  it('没有可用宽度时取近似正方形', () => {
    const out = gridArrange(Array.from({ length: 9 }, (_, i) => ({ id: String(i), x: i, y: 0 })), { x: 0, y: 0 });
    expect(new Set(out.map((o) => o.x)).size).toBe(3);
  });
  it('解除堆叠时 3 列展开（与 SQL unstack 一致：236/120 间距）', () => {
    const out = fanOut(['a', 'b', 'c', 'd'], { x: 0, y: 0 });
    expect(out.map((o) => [o.x, o.y])).toEqual([[0, 0], [236, 0], [472, 0], [0, 120]]);
  });
});

describe('排序键', () => {
  it('在邻居之间取中点，两端扩展', () => {
    expect(positionBetween(undefined, undefined)).toBe(1024);
    expect(positionBetween(1024, undefined)).toBe(2048);
    expect(positionBetween(undefined, 1024)).toBe(0);
    expect(positionBetween(1024, 2048)).toBe(1536);
  });
  it('连续插入仍保持严格有序', () => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 40; i++) {
      const m = positionBetween(lo, hi);
      expect(m).toBeGreaterThan(lo);
      expect(m).toBeLessThan(hi);
      hi = m;
    }
  });
});

describe('区域缩放时条目等比例移动', () => {
  const from = { x: 0, y: 0, width: 1000, height: 800 + REGION_HEADER_H };
  it('保持相对位置与象限；卡片大小不变', () => {
    const r = region(from);
    const to = { x: 100, y: 50, width: 2000, height: 1600 + REGION_HEADER_H };
    const r2 = region(to);
    for (const p of [{ x: 600, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 600 }, { x: 700, y: 650 }]) {
      const q = scaleWithRegion(p, from, to);
      expect(quadrantOf(r2, cardCenter(q))).toBe(quadrantOf(r, cardCenter(p)));
      const c0 = cardCenter(p), c1 = cardCenter(q);
      expect((c1.x - 100) / 2000).toBeCloseTo(c0.x / 1000, 2);
      expect((c1.y - 50 - REGION_HEADER_H) / 1600).toBeCloseTo((c0.y - REGION_HEADER_H) / 800, 2);
    }
  });
  it('尺寸不变时只平移', () => {
    const p = { x: 300, y: 300 };
    expect(scaleWithRegion(p, from, { ...from, x: 40, y: -20 })).toEqual({ x: 340, y: 280 });
  });
});

import { mergeNodes, sameValue } from '../src/canvas/adapter';

describe('画布节点复用（性能）', () => {
  const node = (id: string, data: any, x = 0) => ({ id, type: 'event', position: { x, y: 0 }, data } as any);
  it('内容相同的新对象视为未变化', () => {
    expect(sameValue({ a: 1, p: { done: 1, total: 2 } }, { a: 1, p: { done: 1, total: 2 } })).toBe(true);
    expect(sameValue({ a: 1, p: { done: 1, total: 2 } }, { a: 1, p: { done: 2, total: 2 } })).toBe(false);
  });
  it('没有任何变化时返回原数组；只有变化的节点换成新对象', () => {
    const prev = [node('a', { t: 1 }), node('b', { t: 2 })];
    expect(mergeNodes(prev, [node('a', { t: 1 }), node('b', { t: 2 })], new Set())).toBe(prev);
    const next = mergeNodes(prev, [node('a', { t: 1 }), node('b', { t: 3 })], new Set());
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).not.toBe(prev[1]);
  });
  it('正在拖动的节点保留本地位置', () => {
    const prev = [{ ...node('a', { t: 1 }, 50), dragging: true }];
    expect(mergeNodes(prev, [node('a', { t: 1 }, 0)], new Set())[0].position.x).toBe(50);
  });
});

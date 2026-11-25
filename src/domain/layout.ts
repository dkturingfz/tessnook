// 纯函数：象限判定、网格整理、排序键、卡片堆展开。全部使用世界坐标。
import type { ID, Quadrant, Region } from './types';

export const EVENT_W = 220;
export const EVENT_H_STANDARD = 104;
export const EVENT_H_COMPACT = 44;
/** 用于判定象限的名义卡片高度（与显示密度无关，保证判定稳定） */
export const EVENT_H_NOMINAL = 60;
export const REGION_HEADER_H = 36;
export const GRID_GAP = 16;
export const ARRANGE_PADDING = 24;

export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point {
  width: number;
  height: number;
}

export function cardCenter(p: Point): Point {
  return { x: p.x + EVENT_W / 2, y: p.y + EVENT_H_NOMINAL / 2 };
}

/** 区域中可放置事件的主体部分（去掉标题栏） */
export function regionBody(r: Region): Rect {
  return { x: r.x, y: r.y + REGION_HEADER_H, width: r.width, height: r.height - REGION_HEADER_H };
}

export function contains(rect: Rect, p: Point): boolean {
  return p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
}

/**
 * X 轴向右 = 紧急性增加；Y 轴向上 = 重要性增加（屏幕坐标 y 向下，所以上半部分 = 重要）。
 * Q1 右上 重要紧急；Q2 左上 重要不紧急；Q3 左下；Q4 右下 不重要但紧急。
 */
export function quadrantOf(r: Region, p: Point): Quadrant {
  const b = regionBody(r);
  const urgent = p.x >= b.x + b.width / 2;
  const important = p.y < b.y + b.height / 2;
  if (important) return urgent ? 'Q1' : 'Q2';
  return urgent ? 'Q4' : 'Q3';
}

export function quadrantRect(r: Region, q: Quadrant): Rect {
  const b = regionBody(r);
  const hw = b.width / 2;
  const hh = b.height / 2;
  const right = q === 'Q1' || q === 'Q4';
  const top = q === 'Q1' || q === 'Q2';
  return { x: b.x + (right ? hw : 0), y: b.y + (top ? 0 : hh), width: hw, height: hh };
}

/** 找到包含该点的区域（面积最小者优先，便于区域嵌套摆放） */
export function locate(
  regions: Region[],
  p: Point,
): { region_id: ID | null; quadrant: Quadrant | null } {
  const hits = regions
    .filter((r) => contains(regionBody(r), p))
    .sort((a, b) => a.width * a.height - b.width * b.height);
  const r = hits[0];
  return r ? { region_id: r.id, quadrant: quadrantOf(r, p) } : { region_id: null, quadrant: null };
}

export interface Positioned extends Point {
  id: ID;
}

/**
 * 网格整理：按当前阅读顺序（先行后列）排序，排成整齐的行列。
 * bounds 给出时以其宽度决定列数，否则取近似正方形。
 */
export function gridArrange(
  items: Positioned[],
  origin: Point,
  opts: { availableWidth?: number; rowHeight?: number } = {},
): Positioned[] {
  if (items.length === 0) return [];
  const rowH = opts.rowHeight ?? EVENT_H_STANDARD;
  const cellW = EVENT_W + GRID_GAP;
  const cellH = rowH + GRID_GAP;
  const cols = opts.availableWidth
    ? Math.max(1, Math.floor((opts.availableWidth + GRID_GAP) / cellW))
    : Math.max(1, Math.ceil(Math.sqrt(items.length)));
  // 行容差：y 相差不到半行的视为同一行
  const sorted = [...items].sort((a, b) =>
    Math.abs(a.y - b.y) < rowH / 2 ? a.x - b.x : a.y - b.y,
  );
  return sorted.map((it, i) => ({
    id: it.id,
    x: Math.round(origin.x + (i % cols) * cellW),
    y: Math.round(origin.y + Math.floor(i / cols) * cellH),
  }));
}

/** 为某象限内的整理计算起点与可用宽度 */
export function arrangeTarget(r: Region | undefined, q: Quadrant | null, fallback: Point) {
  if (!r || !q) return { origin: fallback, availableWidth: undefined };
  const rect = quadrantRect(r, q);
  return {
    origin: { x: rect.x + ARRANGE_PADDING, y: rect.y + ARRANGE_PADDING },
    availableWidth: rect.width - ARRANGE_PADDING * 2,
  };
}

/** 排序键：在两个邻居之间取中点；用于看板列与任务的排序 */
export const POSITION_STEP = 1024;
export function positionBetween(before: number | undefined, after: number | undefined): number {
  if (before === undefined && after === undefined) return POSITION_STEP;
  if (before === undefined) return after! - POSITION_STEP;
  if (after === undefined) return before + POSITION_STEP;
  return (before + after) / 2;
}

/** 解除堆叠时，把成员在堆位置附近展开 */
export function fanOut(ids: ID[], origin: Point): Positioned[] {
  return gridArrange(
    ids.map((id, i) => ({ id, x: i, y: 0 })),
    origin,
    { availableWidth: 3 * (EVENT_W + GRID_GAP) },
  );
}

export function boundingBox(points: Point[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * 区域缩放时，区域内条目随之等比例移动：按卡片中心在区域主体中的相对位置换算到新尺寸。
 * 以中心计算，因此条目留在原象限；卡片本身大小不变。
 */
export function scaleWithRegion(p: Point, from: Rect, to: Rect): Point {
  const a = regionBody(from as Region);
  const b = regionBody(to as Region);
  const c = cardCenter(p);
  const u = a.width > 0 ? (c.x - a.x) / a.width : 0.5;
  const v = a.height > 0 ? (c.y - a.y) / a.height : 0.5;
  return {
    x: Math.round(b.x + u * b.width - EVENT_W / 2),
    y: Math.round(b.y + v * b.height - EVENT_H_NOMINAL / 2),
  };
}

/** 防重叠判定用的卡片外框（按标准密度的卡片估算） */
const BOX_W = EVENT_W;
const BOX_H = EVENT_H_STANDARD;
/** 被推开的卡片之间至少留出的空隙 */
const SEPARATION_GAP = 8;
/** 推开卡片时与象限边缘保持的距离 */
const EDGE_PAD = 8;

export interface RegionMember extends Positioned {
  quadrant: Quadrant | null;
}

const overlapping = (a: Point, b: Point, gap = 0) =>
  Math.abs(a.x - b.x) < BOX_W + gap && Math.abs(a.y - b.y) < BOX_H + gap;

/**
 * 区域缩放后，区域内全部条目的新位置。
 *
 * 1. 每个条目先按 scaleWithRegion 等比例移动（相对位置不变）。
 * 2. 只在缩小时：原本互不重叠、缩放后却叠在一起的条目会被轻轻推开，
 *    但始终留在自己的象限内（尽量完整放进象限，放不下时至少保证中心在象限内），
 *    所以象限归属不会因推开而改变。原本就重叠的条目（用户刻意叠放）保持原样。
 *    空间实在不够时允许残留少量重叠，不会把卡片推出象限。
 *
 * 纯函数，结果确定；缩放预览与最终保存都用它，所见即所得。
 */
export function scaleMembersWithRegion(items: RegionMember[], from: Rect, to: Rect): Map<ID, Point> {
  const pos = items.map((it) => scaleWithRegion(it, from, to));
  const out = () => new Map(items.map((it, i) => [it.id, { x: Math.round(pos[i].x), y: Math.round(pos[i].y) }]));
  const shrinking = to.width < from.width || to.height < from.height;
  if (!shrinking || items.length < 2) return out();

  const target = to as Region;
  // 每个条目可移动的范围：完整放进象限；放不下就退而保证中心在象限内；
  // 并且总包含它等比例缩放后的位置（不会因为夹紧而移动没有重叠的卡片）。
  const bounds = items.map((it, i) => {
    if (!it.quadrant) return null;
    const q = quadrantRect(target, it.quadrant);
    const axis = (start: number, size: number, box: number, nominal: number, cur: number) => {
      let lo = start + EDGE_PAD;
      let hi = start + size - box - EDGE_PAD;
      if (lo > hi) {
        lo = start - nominal / 2 + 1;
        hi = start + size - nominal / 2 - 1;
      }
      return [Math.min(lo, cur), Math.max(hi, cur)] as const;
    };
    return {
      x: axis(q.x, q.width, BOX_W, EVENT_W, pos[i].x),
      y: axis(q.y, q.height, BOX_H, EVENT_H_NOMINAL, pos[i].y),
    };
  });
  const clamp = (i: number) => {
    const b = bounds[i];
    if (!b) return;
    pos[i] = {
      x: Math.min(b.x[1], Math.max(b.x[0], pos[i].x)),
      y: Math.min(b.y[1], Math.max(b.y[0], pos[i].y)),
    };
  };

  const pairs: [number, number][] = [];
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++)
      if (items[i].quadrant === items[j].quadrant && !overlapping(items[i], items[j])) pairs.push([i, j]);

  for (let iter = 0; iter < 60; iter++) {
    let moved = false;
    for (const [i, j] of pairs) {
      const a = pos[i];
      const b = pos[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const ox = BOX_W + SEPARATION_GAP - Math.abs(dx);
      const oy = BOX_H + SEPARATION_GAP - Math.abs(dy);
      if (ox <= 0.5 || oy <= 0.5) continue;
      moved = true;
      // 沿需要移动更少的方向推开，两张卡片各让一半
      if (ox < oy) {
        const s = dx > 0 || (dx === 0 && items[i].x <= items[j].x) ? 1 : -1;
        pos[i] = { x: a.x - (s * ox) / 2, y: a.y };
        pos[j] = { x: b.x + (s * ox) / 2, y: b.y };
      } else {
        const s = dy > 0 || (dy === 0 && items[i].y <= items[j].y) ? 1 : -1;
        pos[i] = { x: a.x, y: a.y - (s * oy) / 2 };
        pos[j] = { x: b.x, y: b.y + (s * oy) / 2 };
      }
      clamp(i);
      clamp(j);
    }
    if (!moved) break;
  }
  return out();
}

/**
 * 在象限内为一张卡片找一个不与 occupied 重叠、离 p 最近的位置。
 * 以 p 为中心按网格步长由近及远搜索；象限里实在没有空位时返回 p 本身。
 * 结果的中心点始终在象限内，所以象限归属不变。
 */
export function nearestFreeSpot(p: Point, occupied: Point[], quadrant: Rect): Point {
  const fits = (q: Point) => occupied.every((o) => !overlapping(q, o, SEPARATION_GAP));
  const inside = (q: Point) => {
    const c = cardCenter(q);
    return c.x > quadrant.x && c.x < quadrant.x + quadrant.width && c.y > quadrant.y && c.y < quadrant.y + quadrant.height;
  };
  if (fits(p)) return p;
  const stepX = (BOX_W + SEPARATION_GAP) / 2;
  const stepY = (BOX_H + SEPARATION_GAP) / 2;
  const maxRing = Math.ceil(Math.max(quadrant.width / stepX, quadrant.height / stepY)) + 1;
  for (let ring = 1; ring <= maxRing; ring++) {
    const candidates: Point[] = [];
    for (let i = -ring; i <= ring; i++)
      for (let j = -ring; j <= ring; j++) {
        if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
        candidates.push({ x: Math.round(p.x + i * stepX), y: Math.round(p.y + j * stepY) });
      }
    const ok = candidates
      .filter((q) => inside(q) && fits(q))
      .sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y) || a.y - b.y || a.x - b.x);
    if (ok.length) return ok[0];
  }
  return p;
}

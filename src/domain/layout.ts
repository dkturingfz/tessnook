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

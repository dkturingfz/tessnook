// 画布上的复合操作（整理、缩放区域后的归属校正等），基于纯函数布局算法与 store。
import type { ID, ItemMove, Region } from '../domain/types';
import {
  EVENT_H_COMPACT,
  EVENT_H_STANDARD,
  arrangeTarget,
  boundingBox,
  cardCenter,
  gridArrange,
  locate,
  scaleWithRegion,
  type Point,
  type Rect,
} from '../domain/layout';
import { useStore } from '../store/store';
import { ESCALATE_TO, escalatePosition } from '../domain/deadlines';
import { quadrantName } from '../domain/axes';

type ItemRef = { kind: 'event' | 'stack'; id: ID };

/** 属于该区域的条目：未堆叠的事件包（含已归档，恢复时位置正确）与卡片堆 */
function members(regionId: ID) {
  const s = useStore.getState();
  return [
    ...Object.values(s.events).filter((e) => e.region_id === regionId && !e.stack_id).map((row) => ({ kind: 'event' as const, row })),
    ...Object.values(s.stacks).filter((st) => st.region_id === regionId).map((row) => ({ kind: 'stack' as const, row })),
  ];
}

function rowHeight() {
  return useStore.getState().density === 'compact' ? EVENT_H_COMPACT : EVENT_H_STANDARD;
}

function itemOf(ref: ItemRef) {
  const s = useStore.getState();
  return ref.kind === 'event' ? s.events[ref.id] : s.stacks[ref.id];
}

/** 把一组条目按 (区域, 象限) 分组后分别整理 */
function arrange(refs: ItemRef[], label: string) {
  const s = useStore.getState();
  const groups = new Map<string, ItemRef[]>();
  for (const r of refs) {
    const it = itemOf(r);
    if (!it) continue;
    const key = `${it.region_id ?? ''}|${it.quadrant ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const moves: ItemMove[] = [];
  for (const group of groups.values()) {
    const first = itemOf(group[0])!;
    const items = group.map((g) => ({ id: g.id, x: itemOf(g)!.x, y: itemOf(g)!.y }));
    const bb = boundingBox(items);
    const region = first.region_id ? s.regions[first.region_id] : undefined;
    const { origin, availableWidth } = arrangeTarget(region, first.quadrant, { x: bb.x, y: bb.y });
    const placed = gridArrange(items, origin, { availableWidth, rowHeight: rowHeight() });
    for (const p of placed) {
      const ref = group.find((g) => g.id === p.id)!;
      const it = itemOf(ref)!;
      if (it.x === p.x && it.y === p.y) continue;
      moves.push({ kind: ref.kind, id: p.id, x: p.x, y: p.y, region_id: it.region_id, quadrant: it.quadrant, version: it.version });
    }
  }
  return useStore.getState().moveItems(moves, label);
}

export const canvasActions = {
  /** 截止日期提醒的一键移动：同一高度平移到右侧紧急象限，可用 Ctrl+Z 撤销 */
  async escalate(eventId: ID) {
    const s = useStore.getState();
    const e = s.events[eventId];
    if (!e || !e.region_id || !e.quadrant) return;
    if (e.stack_id) return s.toast('该事件包在卡片堆中，请先解除堆叠再移动', 'error');
    const target = ESCALATE_TO[e.quadrant];
    const region = s.regions[e.region_id];
    if (!target || !region) return;
    const p = escalatePosition(e, region);
    await s.moveItems([{ kind: 'event', id: e.id, x: p.x, y: p.y, region_id: region.id, quadrant: target, version: e.version }], '按截止日期调整');
    s.toast(`已移至「${quadrantName(region, target)}」，可按 Ctrl+Z 撤销`, 'success');
  },

  arrangeSelection(refs: ItemRef[]) {
    return arrange(refs, '网格整理');
  },

  arrangeRegion(regionId: ID) {
    const s = useStore.getState();
    const refs: ItemRef[] = [
      ...Object.values(s.events)
        .filter((e) => e.region_id === regionId && !e.archived_at && !e.stack_id)
        .map((e) => ({ kind: 'event' as const, id: e.id })),
      ...Object.values(s.stacks)
        .filter((st) => st.region_id === regionId)
        .map((st) => ({ kind: 'stack' as const, id: st.id })),
    ];
    return arrange(refs, '整理区域');
  },

  /** 缩放过程中的实时预览：区域内条目的新位置（不写库） */
  previewResize(id: ID, rect: Rect): Map<ID, Point> {
    const s = useStore.getState();
    const before = s.regions[id];
    const out = new Map<ID, Point>();
    if (!before) return out;
    for (const it of members(id)) out.set(it.row.id, scaleWithRegion(it.row, before, rect));
    return out;
  },

  /**
   * 缩放结束：区域内条目按 scaleWithRegion 等比例移动（象限不变），
   * 新覆盖到的、不属于任何区域的条目加入对应象限；与区域尺寸在同一事务中保存。
   */
  async resizeRegion(id: ID, p: Rect) {
    const s = useStore.getState();
    const before = s.regions[id];
    if (!before) return;
    const rect = { x: Math.round(p.x), y: Math.round(p.y), width: Math.round(p.width), height: Math.round(p.height) };
    if (rect.x === before.x && rect.y === before.y && rect.width === before.width && rect.height === before.height) return;
    const after: Region = { ...before, ...rect };
    const moves: ItemMove[] = [];
    for (const { kind, row } of members(id)) {
      const q = scaleWithRegion(row, before, rect);
      if (q.x !== row.x || q.y !== row.y) moves.push({ kind, id: row.id, x: q.x, y: q.y, region_id: id, quadrant: row.quadrant, version: row.version });
    }
    const regions = Object.values(s.regions).map((r) => (r.id === id ? after : r));
    const free = [
      ...Object.values(s.events).filter((e) => !e.region_id && !e.archived_at && !e.stack_id).map((row) => ({ kind: 'event' as const, row })),
      ...Object.values(s.stacks).filter((st) => !st.region_id).map((row) => ({ kind: 'stack' as const, row })),
    ];
    for (const { kind, row } of free) {
      const loc = locate(regions, cardCenter(row));
      if (loc.region_id === id) moves.push({ kind, id: row.id, x: row.x, y: row.y, ...loc, version: row.version });
    }
    await s.resizeRegion(id, rect, moves);
  },
};

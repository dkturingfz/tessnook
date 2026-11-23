// 画布上的复合操作（整理、缩放区域后的归属校正等），基于纯函数布局算法与 store。
import type { ID, ItemMove, Quadrant, Region } from '../domain/types';
import {
  EVENT_H_COMPACT,
  EVENT_H_STANDARD,
  arrangeTarget,
  boundingBox,
  cardCenter,
  gridArrange,
  locate,
} from '../domain/layout';
import { useStore } from '../store/store';

type ItemRef = { kind: 'event' | 'stack'; id: ID };

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

  /** 区域尺寸变化后，按新几何重新判定区域内条目的象限归属 */
  async resizeRegion(id: ID, p: { x: number; y: number; width: number; height: number }) {
    const s = useStore.getState();
    const before = s.regions[id];
    if (!before) return;
    const geom = { x: Math.round(p.x), y: Math.round(p.y), width: Math.round(p.width), height: Math.round(p.height) };
    await s.updateRow('regions', id, geom);
    const after: Region = { ...before, ...geom };
    const others = Object.values(useStore.getState().regions).map((r) => (r.id === id ? after : r));
    const moves: ItemMove[] = [];
    const check = (kind: 'event' | 'stack', it: { id: ID; x: number; y: number; region_id: ID | null; quadrant: Quadrant | null; version: number }) => {
      const loc = locate(others, cardCenter(it));
      if (loc.region_id !== it.region_id || loc.quadrant !== it.quadrant) {
        moves.push({ kind, id: it.id, x: it.x, y: it.y, ...loc, version: it.version });
      }
    };
    const st = useStore.getState();
    Object.values(st.events).filter((e) => e.region_id === id && !e.archived_at && !e.stack_id).forEach((e) => check('event', e));
    Object.values(st.stacks).filter((x) => x.region_id === id).forEach((x) => check('stack', x));
    if (moves.length) await st.moveItems(moves);
  },
};

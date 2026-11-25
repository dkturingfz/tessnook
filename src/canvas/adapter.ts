// 画布适配层：把业务对象转换成 React Flow 节点。业务数据不依赖 React Flow 的节点格式。
import type { Node } from '@xyflow/react';
import type { EventPkg, ID, PresenceState, Quadrant, Region, Stack } from '../domain/types';
import type { DeadlineAlert } from '../domain/deadlines';
import { axesOf } from '../domain/axes';
import type { Density } from '../store/store';

export interface RegionNodeData extends Record<string, unknown> {
  region: Region;
  highlight: Quadrant | null;
  canEdit: boolean;
  counts: Record<Quadrant, number>;
}
export interface EventNodeData extends Record<string, unknown> {
  event: EventPkg;
  progress: { done: number; total: number };
  viewers: PresenceState[];
  density: Density;
  isOpen: boolean;
  alert: DeadlineAlert | null;
  /** escalate 提醒的目标象限短名称，例如 “Q1” 或 “速赢” */
  alertTarget: string | null;
}
export interface StackNodeData extends Record<string, unknown> {
  stack: Stack;
  members: EventPkg[];
  expanded: boolean;
  canEdit: boolean;
  alertCount: number;
}
export interface DraftNodeData extends Record<string, unknown> {
  onSubmit(title: string): void;
  onCancel(): void;
}

export type AppNode =
  | Node<RegionNodeData, 'region'>
  | Node<EventNodeData, 'event'>
  | Node<StackNodeData, 'stack'>
  | Node<DraftNodeData, 'draft'>;

export interface BuildInput {
  regions: Record<ID, Region>;
  events: Record<ID, EventPkg>;
  stacks: Record<ID, Stack>;
  progress: Map<ID, { done: number; total: number }>;
  presence: PresenceState[];
  myId: ID | undefined;
  density: Density;
  canEdit: boolean;
  hover: { region_id: ID | null; quadrant: Quadrant | null } | null;
  expandedStack: ID | null;
  openEventId: ID | null;
  alerts: Map<ID, DeadlineAlert>;
}

export function buildNodes(i: BuildInput): AppNode[] {
  const out: AppNode[] = [];
  const active = Object.values(i.events).filter((e) => !e.archived_at);

  for (const r of Object.values(i.regions)) {
    const counts: Record<Quadrant, number> = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
    for (const e of active) if (e.region_id === r.id && e.quadrant) counts[e.quadrant]++;
    out.push({
      id: r.id,
      type: 'region',
      position: { x: r.x, y: r.y },
      width: r.width,
      height: r.height,
      zIndex: 0,
      selectable: false,
      draggable: i.canEdit,
      dragHandle: '.region-drag',
      // 区域主体不拦截指针：在区域内可以平移画布、框选、双击创建
      style: { pointerEvents: 'none' },
      data: {
        region: r,
        canEdit: i.canEdit,
        counts,
        highlight: i.hover?.region_id === r.id ? i.hover.quadrant : null,
      },
    });
  }

  const viewersOf = (id: ID) => i.presence.filter((p) => p.open_event_id === id && p.user_id !== i.myId);

  for (const e of active) {
    if (e.stack_id) continue;
    out.push({
      id: e.id,
      type: 'event',
      position: { x: e.x, y: e.y },
      zIndex: 10,
      draggable: i.canEdit,
      data: {
        event: e,
        progress: i.progress.get(e.id) ?? { done: 0, total: 0 },
        viewers: viewersOf(e.id),
        density: i.density,
        isOpen: i.openEventId === e.id,
        alert: i.alerts.get(e.id) ?? null,
        alertTarget: (() => {
          const a = i.alerts.get(e.id);
          if (!a?.target || !e.region_id) return null;
          const axes = axesOf(i.regions[e.region_id]);
          return axes.showCodes ? a.target : axes.quadrants[a.target].label;
        })(),
      },
    });
  }

  for (const s of Object.values(i.stacks)) {
    const members = active
      .filter((e) => e.stack_id === s.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (members.length === 0) continue;
    out.push({
      id: s.id,
      type: 'stack',
      position: { x: s.x, y: s.y },
      zIndex: i.expandedStack === s.id ? 1000 : 10,
      draggable: i.canEdit,
      data: { stack: s, members, expanded: i.expandedStack === s.id, canEdit: i.canEdit, alertCount: members.filter((m) => i.alerts.has(m.id)).length },
    });
  }
  return out;
}

/** 有限深度的结构比较：用于判断节点数据是否真的变化（新建的对象但内容相同视为未变） */
export function sameValue(a: unknown, b: unknown, depth = 3): boolean {
  if (a === b) return true;
  if (depth === 0 || typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Map || b instanceof Map) return false;
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!sameValue((a as any)[k], (b as any)[k], depth - 1)) return false;
  return true;
}

/**
 * 把新构建的节点与 React Flow 当前节点合并：
 * - 保留选择状态；正在拖拽/缩放的节点保留其本地位置，避免远端更新打断操作；
 * - 内容没有变化的节点直接复用原对象，React Flow 与 React 会跳过它们的重新渲染。
 *   这让单个节点的变化（拖动高亮、打开看板、单张卡片更新）不再导致全部节点重绘。
 */
export function mergeNodes(prev: AppNode[], next: AppNode[], busy: Set<ID>): AppNode[] {
  const old = new Map(prev.map((n) => [n.id, n]));
  let changed = prev.length !== next.length;
  const out = next.map((n, i) => {
    const p = old.get(n.id);
    if (!p) { changed = true; return n; }
    const keep = busy.has(n.id) || p.dragging;
    const position = keep ? p.position : n.position;
    const width = keep ? p.width : n.width;
    const height = keep ? p.height : n.height;
    const data = sameValue(p.data, n.data) ? p.data : n.data;
    if (
      data === p.data && p.position.x === position.x && p.position.y === position.y && p.width === width && p.height === height &&
      p.type === n.type && p.zIndex === n.zIndex && p.draggable === n.draggable && p.selectable === n.selectable && prev[i] === p
    ) return p;
    changed = true;
    return { ...n, data, position, width, height, selected: p.selected, measured: p.measured } as AppNode;
  });
  return changed ? out : prev;
}

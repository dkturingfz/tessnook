// 工作空间备份：格式定义、校验，以及导入计划（重新生成 id 并保持引用关系）。
// 纯函数，与后端无关；导入总是生成一个新的工作空间，不覆盖现有数据。
import type {
  BoardList, ChecklistItem, EventPkg, ID, Region, Snapshot, Stack, TableName, TableRows, Task,
} from './types';

export const BACKUP_FORMAT = 'tessnook-backup';
export const BACKUP_VERSION = 1;

type Strip<T> = Omit<T, 'workspace_id' | 'version' | 'updated_at'>;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exported_at: string;
  workspace: { name: string };
  regions: Strip<Region>[];
  stacks: Strip<Stack>[];
  events: Strip<EventPkg>[];
  lists: Strip<BoardList>[];
  tasks: Strip<Task>[];
  checklist_items: Strip<ChecklistItem>[];
}

function strip<T extends { workspace_id: ID; version: number; updated_at: string }>(rows: T[]): Strip<T>[] {
  return rows.map(({ workspace_id: _w, version: _v, updated_at: _u, ...rest }) => rest);
}

/** 由快照生成备份（不含成员与活动记录：它们属于账户与权限，而不是工作内容） */
export function buildBackup(snap: Snapshot, now = new Date()): Backup {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: now.toISOString(),
    workspace: { name: snap.workspace.name },
    regions: strip(snap.regions),
    stacks: strip(snap.stacks),
    events: strip(snap.events),
    lists: strip(snap.lists),
    tasks: strip(snap.tasks),
    checklist_items: strip(snap.checklist_items),
  };
}

export function backupFileName(name: string, now = new Date()) {
  const safe = name.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'workspace';
  return `tessnook-${safe}-${now.toISOString().slice(0, 10)}.json`;
}

/** 校验备份文件；返回错误说明，或 null 表示可以导入 */
export function validateBackup(data: unknown): string | null {
  if (!data || typeof data !== 'object') return '不是有效的备份文件';
  const b = data as Partial<Backup>;
  if (b.format !== BACKUP_FORMAT) return '不是 Tessnook 备份文件';
  if (typeof b.version !== 'number' || b.version > BACKUP_VERSION) return '备份文件版本过新，请先更新 Tessnook';
  for (const k of ['regions', 'stacks', 'events', 'lists', 'tasks', 'checklist_items'] as const) {
    if (!Array.isArray(b[k])) return `备份文件缺少 ${k}`;
  }
  if (!b.workspace || typeof b.workspace.name !== 'string') return '备份文件缺少工作空间名称';
  const ids = new Set<string>();
  for (const k of ['regions', 'stacks', 'events', 'lists', 'tasks', 'checklist_items'] as const) {
    for (const r of b[k] as { id?: unknown }[]) {
      if (typeof r?.id !== 'string') return `${k} 中有缺少 id 的记录`;
      if (ids.has(r.id)) return `备份文件中有重复的 id：${r.id}`;
      ids.add(r.id);
    }
  }
  const has = (k: keyof Backup, id: unknown) => id == null || (b[k] as { id: string }[]).some((r) => r.id === id);
  for (const e of b.events!) if (!has('regions', e.region_id) || !has('stacks', e.stack_id)) return `事件包「${e.title}」引用了不存在的区域或卡片堆`;
  for (const s of b.stacks!) if (!has('regions', s.region_id)) return '卡片堆引用了不存在的区域';
  for (const l of b.lists!) if (!has('events', l.event_id)) return `列表「${l.title}」引用了不存在的事件包`;
  for (const t of b.tasks!) if (!has('events', t.event_id) || !has('lists', t.list_id)) return `任务「${t.title}」引用了不存在的事件包或列表`;
  for (const c of b.checklist_items!) if (!has('events', c.event_id) || !has('tasks', c.task_id)) return '检查项引用了不存在的任务';
  return null;
}

export interface ImportStep<T extends TableName = TableName> {
  table: T;
  rows: (Partial<TableRows[T]> & { workspace_id: ID })[];
}

/**
 * 导入计划：按外键依赖排序（区域 → 卡片堆 → 事件包 → 列表 → 任务 → 检查项），
 * 所有 id 重新生成并同步替换引用。
 * 只属于原账户的信息无法带入新空间：负责人只保留导入者本人，归档人记为导入者。
 */
export function planImport(b: Backup, ctx: { workspaceId: ID; userId: ID; newId: () => ID }): ImportStep[] {
  const map = new Map<string, string>();
  const id = (old: string) => {
    let v = map.get(old);
    if (!v) { v = ctx.newId(); map.set(old, v); }
    return v;
  };
  const ref = (old: string | null | undefined) => (old ? id(old) : null);
  const ws = ctx.workspaceId;
  return [
    { table: 'regions', rows: b.regions.map((r) => ({ ...r, id: id(r.id), workspace_id: ws })) },
    { table: 'stacks', rows: b.stacks.map((s) => ({ ...s, id: id(s.id), workspace_id: ws, region_id: ref(s.region_id) })) },
    {
      table: 'events',
      rows: b.events.map((e) => ({
        ...e, id: id(e.id), workspace_id: ws, region_id: ref(e.region_id), stack_id: ref(e.stack_id),
        created_by: ctx.userId, archived_by: e.archived_at ? ctx.userId : null,
      })),
    },
    { table: 'lists', rows: b.lists.map((l) => ({ ...l, id: id(l.id), workspace_id: ws, event_id: id(l.event_id) })) },
    {
      table: 'tasks',
      rows: b.tasks.map((t) => ({
        ...t, id: id(t.id), workspace_id: ws, event_id: id(t.event_id), list_id: id(t.list_id),
        assignee_id: t.assignee_id === ctx.userId ? t.assignee_id : null,
      })),
    },
    { table: 'checklist_items', rows: b.checklist_items.map((c) => ({ ...c, id: id(c.id), workspace_id: ws, event_id: id(c.event_id), task_id: id(c.task_id) })) },
  ] as ImportStep[];
}

import { create } from 'zustand';
import {
  type BoardList,
  type ChangeSet,
  type ChecklistItem,
  type EventPkg,
  type ID,
  type ItemMove,
  type Member,
  type Quadrant,
  type Region,
  type Role,
  type Stack,
  type TableName,
  type TableRows,
  type Task,
  type User,
  type Workspace,
  type WorkspaceWithRole,
} from '../domain/types';
import { positionBetween } from '../domain/layout';
import { ConflictError, repo, type PresenceState, type Subscription } from '../data';

type Rows<T> = Record<ID, T>;
export type PanelMode = 'standard' | 'wide' | 'focus';
export type Density = 'standard' | 'compact';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}

interface LayoutSnapshot {
  label: string;
  items: { kind: 'event' | 'stack'; id: ID; x: number; y: number; region_id: ID | null; quadrant: Quadrant | null }[];
}

interface Data {
  regions: Rows<Region>;
  events: Rows<EventPkg>;
  stacks: Rows<Stack>;
  lists: Rows<BoardList>;
  tasks: Rows<Task>;
  checklist_items: Rows<ChecklistItem>;
}

const emptyData = (): Data => ({ regions: {}, events: {}, stacks: {}, lists: {}, tasks: {}, checklist_items: {} });

// —— 个人界面偏好：只存本地，不同步给其他成员 ——
const PREFS_KEY = 'spatial-board:prefs';
function loadPrefs(): { panelWidth: number; density: Density; lastWorkspace?: ID } {
  try {
    return { panelWidth: 0.4, density: 'standard', ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { panelWidth: 0.4, density: 'standard' };
  }
}
function savePrefs(p: Partial<ReturnType<typeof loadPrefs>>) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...p }));
  } catch {
    /* 隐私模式等情况下忽略 */
  }
}

export interface AppState extends Data {
  user: User | null;
  authChecked: boolean;
  workspaces: WorkspaceWithRole[];
  workspace: Workspace | null;
  role: Role | null;
  members: Member[];
  presence: PresenceState[];
  loading: boolean;

  openEventId: ID | null;
  panelMode: PanelMode;
  panelWidth: number; // 标准模式下的宽度占比
  density: Density;
  focusRequest: { id: ID; at: number } | null;
  toasts: Toast[];
  layoutHistory: LayoutSnapshot[];
  pendingOps: number;

  // 账户 / 空间
  init(): Promise<void>;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, name: string): Promise<void>;
  signOut(): Promise<void>;
  refreshWorkspaces(): Promise<void>;
  openWorkspace(id: ID): Promise<void>;
  createWorkspace(name: string): Promise<void>;
  resync(): Promise<void>;

  // 界面
  openEvent(id: ID | null): void;
  setPanelMode(m: PanelMode): void;
  setPanelWidth(w: number): void;
  setDensity(d: Density): void;
  focusEvent(id: ID): void;
  toast(text: string, kind?: Toast['kind']): void;
  dismissToast(id: number): void;

  // 数据变更
  apply(cs: ChangeSet): void;
  updateRow<T extends TableName>(table: T, id: ID, patch: Partial<TableRows[T]>): Promise<void>;
  insertRow<T extends TableName>(table: T, row: Partial<TableRows[T]>): Promise<TableRows[T] | null>;
  removeRow(table: TableName, id: ID): Promise<void>;

  createEvent(title: string, x: number, y: number, region_id: ID | null, quadrant: Quadrant | null): Promise<ID | null>;
  moveItems(moves: ItemMove[], historyLabel?: string): Promise<void>;
  moveRegion(id: ID, x: number, y: number, version: number): Promise<void>;
  deleteRegion(id: ID): Promise<void>;
  createRegion(x: number, y: number): Promise<void>;
  createStack(eventIds: ID[]): Promise<void>;
  unstack(stackId: ID): Promise<void>;
  setEventStatus(id: ID, status: EventPkg['status']): Promise<void>;
  archiveEvent(id: ID, complete: boolean): Promise<void>;
  restoreEvent(id: ID): Promise<void>;
  undoLayout(): Promise<void>;

  addList(eventId: ID, title: string): Promise<void>;
  moveList(listId: ID, beforeId: ID | undefined, afterId: ID | undefined): Promise<void>;
  addTask(listId: ID, title: string): Promise<void>;
  moveTask(taskId: ID, listId: ID, position: number): Promise<void>;
  addChecklistItem(taskId: ID, text: string): Promise<void>;
}

let sub: Subscription | null = null;
let toastSeq = 1;
let resyncTimer: ReturnType<typeof setTimeout> | null = null;

/** 所有写操作串行执行，避免同一客户端的连续修改因版本号尚未返回而自我冲突 */
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

export const useStore = create<AppState>((set, get) => {
  /** 统一的写操作包装：乐观更新失败时提示并以服务端数据校准 */
  async function mutate<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    if (get().role === 'viewer') {
      get().toast('当前为只读（Viewer）身份', 'error');
      return null;
    }
    set((s) => ({ pendingOps: s.pendingOps + 1 }));
    try {
      return await enqueue(fn);
    } catch (e) {
      if (e instanceof ConflictError) {
        get().toast(`${label}失败：该内容刚被其他成员修改，已刷新为最新版本，请重试`, 'error');
      } else {
        get().toast(`${label}失败：${(e as Error).message}`, 'error');
      }
      await get().resync();
      return null;
    } finally {
      set((s) => ({ pendingOps: s.pendingOps - 1 }));
    }
  }

  function patchLocal<T extends TableName>(table: T, id: ID, patch: Partial<TableRows[T]>) {
    set((s) => {
      const cur = (s[table] as Rows<TableRows[T]>)[id];
      if (!cur) return {};
      return { [table]: { ...(s[table] as object), [id]: { ...cur, ...patch } } } as any;
    });
  }

  function snapshotLayout(label: string, ids: { kind: 'event' | 'stack'; id: ID }[]): LayoutSnapshot {
    const s = get();
    return {
      label,
      items: ids.map(({ kind, id }) => {
        const r = kind === 'event' ? s.events[id] : s.stacks[id];
        return { kind, id, x: r.x, y: r.y, region_id: r.region_id, quadrant: r.quadrant };
      }),
    };
  }

  function subscribeWorkspace(ws: ID) {
    sub?.close();
    sub = repo.subscribe(ws, {
      onChange: (cs) => get().apply(cs),
      onResync: () => {
        // 合并短时间内的多次校准请求
        if (resyncTimer) clearTimeout(resyncTimer);
        resyncTimer = setTimeout(() => get().resync(), 150);
      },
      onPresence: (list) => set({ presence: list }),
      onMembersChanged: async () => {
        await get().refreshWorkspaces();
        const cur = get().workspace;
        if (cur && !get().workspaces.some((w) => w.id === cur.id)) {
          get().toast('你已不再是该工作空间的成员', 'error');
          sub?.close();
          sub = null;
          set({ workspace: null, role: null, ...emptyData(), openEventId: null });
          return;
        }
        await get().resync();
      },
    });
    trackPresence();
  }

  function trackPresence() {
    const s = get();
    if (!sub || !s.user) return;
    sub.track({ user_id: s.user.id, display_name: s.user.display_name, open_event_id: s.openEventId });
  }

  const prefs = loadPrefs();

  return {
    ...emptyData(),
    user: null,
    authChecked: false,
    workspaces: [],
    workspace: null,
    role: null,
    members: [],
    presence: [],
    loading: false,
    openEventId: null,
    panelMode: 'standard',
    panelWidth: prefs.panelWidth,
    density: prefs.density,
    focusRequest: null,
    toasts: [],
    layoutHistory: [],
    pendingOps: 0,

    // ———————————————— 账户 / 空间 ————————————————

    async init() {
      const user = await repo.currentUser().catch(() => null);
      set({ user, authChecked: true });
      if (user) await get().refreshWorkspaces();
    },

    async signIn(email, password) {
      const user = await repo.signIn(email, password);
      set({ user });
      await get().refreshWorkspaces();
    },

    async signUp(email, password, name) {
      const user = await repo.signUp(email, password, name);
      set({ user });
      await get().refreshWorkspaces();
    },

    async signOut() {
      sub?.close();
      sub = null;
      await repo.signOut();
      set({ user: null, workspace: null, workspaces: [], role: null, ...emptyData(), openEventId: null });
    },

    async refreshWorkspaces() {
      const workspaces = await repo.listWorkspaces();
      set({ workspaces });
    },

    async openWorkspace(id) {
      set({ loading: true, openEventId: null, layoutHistory: [] });
      try {
        const snap = await repo.loadSnapshot(id);
        const byId = <T extends { id: ID }>(rows: T[]) => Object.fromEntries(rows.map((r) => [r.id, r]));
        set({
          workspace: snap.workspace,
          role: snap.role,
          members: snap.members,
          regions: byId(snap.regions),
          events: byId(snap.events),
          stacks: byId(snap.stacks),
          lists: byId(snap.lists),
          tasks: byId(snap.tasks),
          checklist_items: byId(snap.checklist_items),
        });
        savePrefs({ lastWorkspace: id });
        subscribeWorkspace(id);
      } catch (e) {
        get().toast((e as Error).message, 'error');
      } finally {
        set({ loading: false });
      }
    },

    async createWorkspace(name) {
      const ws = await repo.createWorkspace(name);
      await get().refreshWorkspaces();
      await get().openWorkspace(ws.id);
    },

    async resync() {
      const ws = get().workspace;
      if (!ws) return;
      try {
        const snap = await repo.loadSnapshot(ws.id);
        const byId = <T extends { id: ID }>(rows: T[]) => Object.fromEntries(rows.map((r) => [r.id, r]));
        set((s) => ({
          workspace: snap.workspace,
          role: snap.role,
          members: snap.members,
          regions: byId(snap.regions),
          events: byId(snap.events),
          stacks: byId(snap.stacks),
          lists: byId(snap.lists),
          tasks: byId(snap.tasks),
          checklist_items: byId(snap.checklist_items),
          openEventId: s.openEventId && snap.events.some((e) => e.id === s.openEventId) ? s.openEventId : null,
        }));
      } catch (e) {
        get().toast(`同步失败：${(e as Error).message}`, 'error');
      }
    },

    // ———————————————— 界面 ————————————————

    openEvent(id) {
      set({ openEventId: id });
      trackPresence();
    },
    setPanelMode(panelMode) {
      set({ panelMode });
    },
    setPanelWidth(w) {
      const panelWidth = Math.min(0.85, Math.max(0.25, w));
      set({ panelWidth });
      savePrefs({ panelWidth });
    },
    setDensity(density) {
      set({ density });
      savePrefs({ density });
    },
    focusEvent(id) {
      set({ focusRequest: { id, at: Date.now() } });
    },
    toast(text, kind = 'info') {
      const id = toastSeq++;
      set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
      setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3000);
    },
    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    // ———————————————— 数据变更 ————————————————

    apply(cs) {
      set((s) => {
        const next: Partial<Data> = {};
        const tbl = <T extends TableName>(t: T): Rows<TableRows[T]> => {
          if (!next[t]) (next as any)[t] = { ...s[t] };
          return next[t] as Rows<TableRows[T]>;
        };
        for (const { table, row } of cs.upserts) {
          const rows = tbl(table) as Rows<any>;
          const cur = rows[row.id];
          // 只接受不旧于本地的版本，避免乱序到达的消息回退状态
          if (!cur || row.version >= cur.version) rows[row.id] = row;
        }
        for (const { table, id } of cs.deletes) delete (tbl(table) as Rows<any>)[id];
        const openGone = s.openEventId && next.events && !next.events[s.openEventId];
        return { ...next, ...(openGone ? { openEventId: null } : {}) };
      });
    },

    async updateRow(table, id, patch) {
      const cur = (get()[table] as Rows<any>)[id];
      if (!cur) return;
      patchLocal(table, id, patch);
      await mutate('保存', async () => {
        const latest = (get()[table] as Rows<any>)[id];
        const row = await repo.update(table, id, patch, latest.version);
        get().apply({ upserts: [{ table, row }], deletes: [] });
      });
    },

    async insertRow(table, row) {
      const ws = get().workspace!;
      return mutate('创建', async () => {
        const created = await repo.insert(table, { ...row, workspace_id: ws.id } as any);
        get().apply({ upserts: [{ table, row: created }], deletes: [] });
        return created;
      });
    },

    async removeRow(table, id) {
      await mutate('删除', async () => {
        await repo.remove(table, id);
        await get().resync(); // 删除会级联，直接以快照校准
      });
    },

    async createEvent(title, x, y, region_id, quadrant) {
      const ws = get().workspace!;
      const cs = await mutate('创建事件包', () =>
        repo.createEvent({ workspace_id: ws.id, title, x, y, region_id, quadrant, with_default_lists: true }),
      );
      if (!cs) return null;
      get().apply(cs);
      return cs.upserts.find((u) => u.table === 'events')?.row.id ?? null;
    },

    async moveItems(moves, historyLabel) {
      if (!moves.length) return;
      const ws = get().workspace!;
      if (historyLabel) {
        const snap = snapshotLayout(historyLabel, moves.map((m) => ({ kind: m.kind, id: m.id })));
        set((s) => ({ layoutHistory: [...s.layoutHistory.slice(-19), snap] }));
      }
      for (const m of moves) {
        patchLocal(m.kind === 'event' ? 'events' : 'stacks', m.id, {
          x: m.x, y: m.y, region_id: m.region_id, quadrant: m.region_id ? m.quadrant : null,
        });
      }
      const cs = await mutate('移动', () => repo.moveItems(ws.id, moves));
      if (cs) get().apply(cs);
    },

    async moveRegion(id, x, y, version) {
      patchLocal('regions', id, { x, y });
      const cs = await mutate('移动区域', () => repo.moveRegion(id, x, y, version));
      if (cs) get().apply(cs);
    },

    async deleteRegion(id) {
      const cs = await mutate('删除区域', () => repo.deleteRegion(id));
      if (cs) get().apply(cs);
    },

    async createRegion(x, y) {
      const n = Object.keys(get().regions).length + 1;
      await get().insertRow('regions', { name: `四象限区域 ${n}`, x, y, width: 1200, height: 800 });
    },

    async createStack(eventIds) {
      const ws = get().workspace!;
      const cs = await mutate('堆叠', () => repo.createStack(ws.id, eventIds, null));
      if (cs) get().apply(cs);
    },

    async unstack(stackId) {
      const cs = await mutate('解除堆叠', () => repo.unstack(stackId));
      if (cs) get().apply(cs);
    },

    async setEventStatus(id, status) {
      await get().updateRow('events', id, { status });
    },

    async archiveEvent(id, complete) {
      const e = get().events[id];
      if (!e) return;
      patchLocal('events', id, { archived_at: new Date().toISOString() });
      const cs = await mutate('归档', () => repo.archiveEvent(id, e.version, complete));
      if (cs) {
        get().apply(cs);
        if (get().openEventId === id) get().openEvent(null);
        get().toast(`已归档「${e.title}」，可在归档中心恢复`, 'success');
      }
    },

    async restoreEvent(id) {
      const cs = await mutate('恢复', () => repo.restoreEvent(id));
      if (cs) {
        get().apply(cs);
        get().focusEvent(id);
        get().toast('已恢复到画布', 'success');
      }
    },

    async undoLayout() {
      const hist = get().layoutHistory;
      const last = hist[hist.length - 1];
      if (!last) return;
      set({ layoutHistory: hist.slice(0, -1) });
      const s = get();
      const moves: ItemMove[] = last.items
        .map((it) => {
          const cur = it.kind === 'event' ? s.events[it.id] : s.stacks[it.id];
          if (!cur || (it.kind === 'event' && (cur as EventPkg).stack_id)) return null;
          const regionOk = !it.region_id || s.regions[it.region_id];
          return { ...it, region_id: regionOk ? it.region_id : null, version: cur.version } as ItemMove;
        })
        .filter((m): m is ItemMove => !!m);
      await get().moveItems(moves);
      get().toast(`已撤销：${last.label}`);
    },

    // ———————————————— 看板 ————————————————

    async addList(eventId, title) {
      const lists = Object.values(get().lists).filter((l) => l.event_id === eventId);
      const last = Math.max(0, ...lists.map((l) => l.position));
      await get().insertRow('lists', { event_id: eventId, title, position: positionBetween(last || undefined, undefined) });
    },

    async moveList(listId, beforeId, afterId) {
      const s = get();
      const pos = positionBetween(
        beforeId ? s.lists[beforeId]?.position : undefined,
        afterId ? s.lists[afterId]?.position : undefined,
      );
      await get().updateRow('lists', listId, { position: pos });
    },

    async addTask(listId, title) {
      const l = get().lists[listId];
      const tasks = Object.values(get().tasks).filter((t) => t.list_id === listId);
      const last = tasks.length ? Math.max(...tasks.map((t) => t.position)) : undefined;
      await get().insertRow('tasks', {
        event_id: l.event_id, list_id: listId, title, position: positionBetween(last, undefined),
      });
    },

    async moveTask(taskId, listId, position) {
      const t = get().tasks[taskId];
      if (!t) return;
      patchLocal('tasks', taskId, { list_id: listId, position });
      const cs = await mutate('移动任务', () => {
        const latest = get().tasks[taskId];
        return repo.moveTask(taskId, listId, position, latest.version);
      });
      if (cs) get().apply(cs);
    },

    async addChecklistItem(taskId, text) {
      const t = get().tasks[taskId];
      const items = Object.values(get().checklist_items).filter((c) => c.task_id === taskId);
      const last = items.length ? Math.max(...items.map((c) => c.position)) : undefined;
      await get().insertRow('checklist_items', {
        event_id: t.event_id, task_id: taskId, text, position: positionBetween(last, undefined),
      });
    },
  };
});

// —— 常用派生查询 ——
export const canEdit = (s: AppState) => s.role === 'owner' || s.role === 'editor';

export function eventProgress(s: Pick<AppState, 'tasks'>, eventId: ID) {
  let total = 0;
  let done = 0;
  for (const t of Object.values(s.tasks)) {
    if (t.event_id !== eventId) continue;
    total++;
    if (t.done) done++;
  }
  return { total, done };
}

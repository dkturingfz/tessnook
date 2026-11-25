import { create } from 'zustand';
import {
  type Activity,
  type BoardList,
  type ChangeSet,
  type ChecklistItem,
  type EventPkg,
  type ID,
  type ItemMove,
  type Member,
  type PresenceState,
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
import { nearestFreeSpot, positionBetween, quadrantRect } from '../domain/layout';
import { can, validateStack, type Action } from '../domain/rules';
import { backupFileName, validateBackup, type Backup } from '../domain/backup';
import { exportBackup, importBackup } from './backup';
import { DEFAULT_LEAD_DAYS, type LeadDays } from '../domain/deadlines';
// 只依赖后端契约（接口与错误类型），不依赖任何具体实现
import { ConflictError, PermissionError, type BackendInfo, type RegionRect, type Repo, type Subscription } from '../data/repo';

type Rows<T> = Record<ID, T>;
export type PanelMode = 'standard' | 'wide' | 'focus';
export type Density = 'standard' | 'compact';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
  /** 可选的操作按钮，例如“撤销” */
  action?: { label: string; run(): void };
}

interface LayoutSnapshot {
  label: string;
  items: { kind: 'event' | 'stack'; id: ID; x: number; y: number; region_id: ID | null; quadrant: Quadrant | null }[];
  /** 调整区域尺寸时记录原尺寸，撤销时与条目位置在同一事务中恢复 */
  region?: { id: ID; x: number; y: number; width: number; height: number };
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
const PREFS_KEY = 'tessnook:prefs';
interface Prefs {
  panelWidth: number;
  density: Density;
  lastWorkspace?: ID;
  /** 截止日期提前提醒的天数 */
  leadDays: LeadDays;
  /** 已选择“暂不提醒”的提醒键（截止日期变化后键也会变化） */
  snoozed: string[];
  /** 外观：跟随系统 / 浅色 / 深色 */
  theme: Theme;
}
const DEFAULT_PREFS: Prefs = { panelWidth: 0.4, density: 'standard', leadDays: DEFAULT_LEAD_DAYS, snoozed: [], theme: 'system' };
export type Theme = 'system' | 'light' | 'dark';

/** 应用外观：system 时移除 data-theme，由系统偏好决定 */
function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}
function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_PREFS };
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
  backend: BackendInfo | null;
  /** 浏览器网络是否可用；断网时暂停编辑，恢复后自动同步 */
  online: boolean;
  /** 实时通道状态：重连期间仍可编辑，只是看不到他人的即时变化 */
  realtime: 'connected' | 'reconnecting';
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
  leadDays: LeadDays;
  snoozed: string[];
  theme: Theme;
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
  /** quiet：自动打开上次的工作空间时使用，失败不提示（例如已被移出该空间），由调用方回退 */
  openWorkspace(id: ID, opts?: { quiet?: boolean }): Promise<void>;
  createWorkspace(name: string): Promise<void>;
  /** 下载当前工作空间的备份文件 */
  exportBackup(): Promise<void>;
  /** 从备份文件导入为新的工作空间 */
  importBackupFile(file: File): Promise<void>;
  /** 正在进行的长操作提示（如导入进度） */
  busy: string | null;
  renameWorkspace(name: string): Promise<void>;
  deleteWorkspace(): Promise<void>;
  resync(): Promise<void>;

  // 成员与活动
  inviteMember(email: string | null, role: Role): Promise<string | null>;
  acceptInvitation(token: string): Promise<void>;
  setMemberRole(userId: ID, role: Role): Promise<void>;
  removeMember(userId: ID): Promise<void>;
  listActivity(limit: number): Promise<Activity[]>;

  // 界面
  openEvent(id: ID | null): void;
  setPanelMode(m: PanelMode): void;
  setPanelWidth(w: number): void;
  setDensity(d: Density): void;
  setLeadDays(d: LeadDays): void;
  setTheme(t: Theme): void;
  snoozeAlert(key: string): void;
  focusEvent(id: ID): void;
  toast(text: string, kind?: Toast['kind'], action?: Toast['action']): void;
  dismissToast(id: number): void;

  // 数据变更
  apply(cs: ChangeSet): void;
  updateRow<T extends TableName>(table: T, id: ID, patch: Partial<TableRows[T]>): Promise<void>;
  insertRow<T extends TableName>(table: T, row: Partial<TableRows[T]>): Promise<TableRows[T] | null>;
  removeRow(table: TableName, id: ID): Promise<void>;

  createEvent(title: string, x: number, y: number, region_id: ID | null, quadrant: Quadrant | null): Promise<ID | null>;
  moveItems(moves: ItemMove[], historyLabel?: string): Promise<void>;
  moveRegion(id: ID, x: number, y: number, version: number): Promise<void>;
  /** historyLabel 为 null 时不记入撤销历史（撤销操作本身使用） */
  resizeRegion(id: ID, rect: RegionRect, moves: ItemMove[], historyLabel?: string | null): Promise<void>;
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

let repo: Repo | null = null;
let networkWatched = false;

/** 监听浏览器网络状态：断网时暂停编辑，恢复后以服务端数据校准 */
function watchNetwork() {
  if (networkWatched || typeof window === 'undefined') return;
  networkWatched = true;
  window.addEventListener('offline', () => useStore.setState({ online: false }));
  window.addEventListener('online', async () => {
    useStore.setState({ online: true });
    const s = useStore.getState();
    if (s.workspace) {
      await s.resync();
      // 同步时可能发现已被移出该空间（已回到选择页并另有说明），此时不再提示“已同步”
      if (useStore.getState().workspace) s.toast('网络已恢复，已同步最新数据', 'success');
    }
  });
}
let sub: Subscription | null = null;

/** 由组合根（main.tsx）在启动时注入后端实现 */
export function configureBackend(r: Repo) {
  repo = r;
  useStore.setState({ backend: r.info });
}
function backend(): Repo {
  if (!repo) throw new Error('后端尚未配置：请先调用 configureBackend()');
  return repo;
}
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
  /** 能否写入：网络可用且有权限。先在本地显示修改的操作必须在修改之前调用，避免残留未保存的本地修改 */
  function guard(action: Action = 'edit'): boolean {
    if (!get().online) {
      get().toast('网络已断开，暂时无法保存；恢复连接后再试', 'error');
      return false;
    }
    if (!can(get().role, action)) {
      get().toast(get().role === 'viewer' ? '当前为只读（Viewer）身份' : '没有执行该操作的权限', 'error');
      return false;
    }
    return true;
  }

  async function mutate<T>(label: string, fn: () => Promise<T>, action: Action = 'edit'): Promise<T | null> {
    if (!guard(action)) return null;
    set((s) => ({ pendingOps: s.pendingOps + 1 }));
    try {
      // 在队列内记录自己写入产生的版本号，保证排在后面的写入执行时已能看到
      return await enqueue(async () => {
        const result = await fn();
        recordOwn(result);
        return result;
      });
    } catch (e) {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        // 请求途中断网：只提示一次，恢复后会自动同步
        set({ online: false });
        get().toast(`${label}未保存：网络已断开`, 'error');
        return null;
      }
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

  const rowOfMove = (m: ItemMove) => (m.kind === 'event' ? get().events[m.id] : get().stacks[m.id]);

  /** 本客户端自己的写入产生的版本号（按行 id）。用于区分“版本变了是因为自己刚保存过”与“别人改过” */
  const ownVersions = new Map<ID, Set<number>>();
  function recordOwn(result: unknown) {
    const rows: unknown[] =
      result && typeof result === 'object' && Array.isArray((result as ChangeSet).upserts)
        ? (result as ChangeSet).upserts.map((u) => u.row)
        : [result];
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const { id, version } = r as { id?: unknown; version?: unknown };
      if (typeof id !== 'string' || typeof version !== 'number') continue;
      const set = ownVersions.get(id) ?? new Set<number>();
      set.add(version);
      ownVersions.set(id, set);
    }
  }
  /** 从 base 到 latest 之间的每一次版本递增都来自自己的写入 */
  function onlyOwnSince(id: ID, base: number, latest: number) {
    const own = ownVersions.get(id);
    if (!own) return base === latest;
    for (let v = base + 1; v <= latest; v++) if (!own.has(v)) return false;
    return true;
  }
  /**
   * 写入在队列中排队执行。执行时若本地版本比调用方给的新，且新出来的版本全部来自自己的写入
   * （刚放下又拖、改完标题立刻移动……），改用最新版本，不当成冲突；
   * 只要其中有他人的修改，就保留调用方给的版本，让后端报告冲突。
   * 返回的函数在队列内执行时调用。
   */
  function freshVersions(moves: ItemMove[]): () => ItemMove[] {
    return () =>
      moves.map((m) => {
        const latest = rowOfMove(m)?.version;
        return latest !== undefined && latest > m.version && onlyOwnSince(m.id, m.version, latest) ? { ...m, version: latest } : m;
      });
  }
  /** 单行版本的同一规则 */
  function freshVersion(id: ID, base: number, latest: number | undefined) {
    return latest !== undefined && latest > base && onlyOwnSince(id, base, latest) ? latest : base;
  }

  /** 离开当前工作空间、回到空间选择页（删除、退出、被移出时共用） */
  async function closeWorkspace(message?: string) {
    sub?.close();
    sub = null;
    // 先刷新列表再清空当前空间，避免“自动打开上次空间”的逻辑看到已不可用的空间
    await get().refreshWorkspaces().catch(() => undefined);
    set({ workspace: null, role: null, ...emptyData(), openEventId: null, layoutHistory: [] });
    if (message) get().toast(message);
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
    sub = backend().subscribe(ws, {
      onChange: (cs) => get().apply(cs),
      onResync: () => {
        // 合并短时间内的多次校准请求
        if (resyncTimer) clearTimeout(resyncTimer);
        resyncTimer = setTimeout(() => get().resync(), 150);
      },
      onPresence: (list) => set({ presence: list }),
      onStatus: (realtime) => set({ realtime }),
      onMembersChanged: async () => {
        await get().refreshWorkspaces();
        const cur = get().workspace;
        if (cur && !get().workspaces.some((w) => w.id === cur.id)) {
          await closeWorkspace(`你已不再是「${cur.name}」的成员`);
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
    backend: null,
    // 只有明确为 false 才视为断网（某些环境中 navigator.onLine 不存在）
    online: typeof navigator === 'undefined' || navigator.onLine !== false,
    realtime: 'connected',
    busy: null,
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
    leadDays: prefs.leadDays,
    snoozed: prefs.snoozed,
    theme: prefs.theme,
    focusRequest: null,
    toasts: [],
    layoutHistory: [],
    pendingOps: 0,

    // ———————————————— 账户 / 空间 ————————————————

    async init() {
      watchNetwork();
      const user = await backend().currentUser().catch(() => null);
      set({ user, authChecked: true });
      if (user) await get().refreshWorkspaces();
    },

    async signIn(email, password) {
      const user = await backend().signIn(email, password);
      set({ user });
      await get().refreshWorkspaces();
    },

    async signUp(email, password, name) {
      const user = await backend().signUp(email, password, name);
      set({ user });
      await get().refreshWorkspaces();
    },

    async signOut() {
      sub?.close();
      sub = null;
      await backend().signOut();
      set({ user: null, workspace: null, workspaces: [], role: null, ...emptyData(), openEventId: null });
    },

    async refreshWorkspaces() {
      const workspaces = await backend().listWorkspaces();
      set({ workspaces });
    },

    async openWorkspace(id, opts) {
      set({ loading: true, openEventId: null, layoutHistory: [] });
      try {
        const snap = await backend().loadSnapshot(id);
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
        if (!opts?.quiet) get().toast((e as Error).message, 'error');
      } finally {
        set({ loading: false });
      }
    },

    async exportBackup() {
      const ws = get().workspace;
      if (!ws) return;
      try {
        const backup = await exportBackup(backend(), ws.id);
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = backupFileName(ws.name);
        // 链接需要在文档中，浏览器才会采用 download 指定的文件名
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        get().toast(`已导出 ${backup.events.length} 个事件包、${backup.tasks.length} 个任务`, 'success');
      } catch (e) {
        get().toast(`导出失败：${(e as Error).message}`, 'error');
      }
    },

    async importBackupFile(file) {
      let backup: Backup;
      try {
        backup = JSON.parse(await file.text());
      } catch {
        get().toast('无法读取：这不是有效的 JSON 文件', 'error');
        return;
      }
      const problem = validateBackup(backup);
      if (problem) {
        get().toast(`无法导入：${problem}`, 'error');
        return;
      }
      const name = `${backup.workspace.name}（导入）`.slice(0, 120);
      const summary = `${backup.events.length} 个事件包、${backup.tasks.length} 个任务`;
      if (!confirm(`将备份「${backup.workspace.name}」（${summary}）导入为新的工作空间「${name}」？\n现有工作空间不会被修改。`)) return;
      set({ busy: '正在导入…' });
      try {
        const id = await importBackup(backend(), backup, {
          userId: get().user!.id, name,
          onProgress: (done, total) => set({ busy: `正在导入… ${done}/${total}` }),
        });
        await get().refreshWorkspaces();
        await get().openWorkspace(id);
        get().toast(`已导入为新的工作空间「${name}」`, 'success');
      } catch (e) {
        get().toast(`导入失败，未创建任何工作空间：${(e as Error).message}`, 'error');
      } finally {
        set({ busy: null });
      }
    },

    async createWorkspace(name) {
      const ws = await backend().createWorkspace(name);
      await get().refreshWorkspaces();
      await get().openWorkspace(ws.id);
    },

    async renameWorkspace(name) {
      const ws = get().workspace!;
      await mutate('重命名', () => backend().renameWorkspace(ws.id, name), 'renameWorkspace');
      await get().refreshWorkspaces();
      await get().resync();
    },

    async deleteWorkspace() {
      const ws = get().workspace!;
      const ok = await mutate('删除工作空间', async () => { await backend().deleteWorkspace(ws.id); return true; }, 'deleteWorkspace');
      if (!ok) return;
      await closeWorkspace();
    },

    async inviteMember(email, role) {
      const ws = get().workspace!;
      return mutate('邀请', () => backend().inviteMember(ws.id, email, role), 'manageMembers');
    },

    async acceptInvitation(token) {
      try {
        const wsId = await backend().acceptInvitation(token);
        await get().refreshWorkspaces();
        await get().openWorkspace(wsId);
        get().toast('已加入工作空间', 'success');
      } catch (e) {
        get().toast(`邀请：${(e as Error).message}`, 'error');
      }
    },

    async setMemberRole(userId, role) {
      const ws = get().workspace!;
      await mutate('调整角色', () => backend().setMemberRole(ws.id, userId, role), 'manageMembers');
      await get().resync();
    },

    async removeMember(userId) {
      const ws = get().workspace!;
      const self = userId === get().user?.id;
      // 成员可以自行退出；移除他人需要管理权限
      const ok = await mutate(self ? '退出' : '移除成员', async () => { await backend().removeMember(ws.id, userId); return true; }, self ? 'view' : 'manageMembers');
      if (!ok) return;
      // 自己退出后已无权读取该空间：回到空间选择页，而不是尝试同步并报错
      if (self) await closeWorkspace(`已退出「${ws.name}」`);
      else await get().resync();
    },

    async listActivity(limit) {
      const ws = get().workspace;
      if (!ws) return [];
      return backend().listActivity(ws.id, limit);
    },

    async resync() {
      if (!get().online) return;
      const ws = get().workspace;
      if (!ws) return;
      try {
        const snap = await backend().loadSnapshot(ws.id);
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
        // 被移出该空间（或空间已被删除）：回到空间选择页并说明原因
        if (e instanceof PermissionError) await closeWorkspace(`你已不再是「${ws.name}」的成员`);
        else get().toast(`同步失败：${(e as Error).message}`, 'error');
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
    setTheme(theme) {
      applyTheme(theme);
      set({ theme });
      savePrefs({ theme });
    },
    setLeadDays(leadDays) {
      set({ leadDays });
      savePrefs({ leadDays });
    },
    snoozeAlert(key) {
      // 只保留最近 500 条，避免无限增长
      const snoozed = [...get().snoozed.filter((k) => k !== key), key].slice(-500);
      set({ snoozed });
      savePrefs({ snoozed });
    },
    setDensity(density) {
      set({ density });
      savePrefs({ density });
    },
    focusEvent(id) {
      set({ focusRequest: { id, at: Date.now() } });
    },
    toast(text, kind = 'info', action) {
      const id = toastSeq++;
      set((s) => ({ toasts: [...s.toasts, { id, kind, text, action }] }));
      // 带操作的提示多停留一会儿，留出点击时间
      setTimeout(() => get().dismissToast(id), kind === 'error' && action ? 10000 : kind === 'error' || action ? 6000 : 3000);
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
      if (!guard('edit')) return;
      const cur = (get()[table] as Rows<any>)[id];
      if (!cur) return;
      patchLocal(table, id, patch);
      await mutate('保存', async () => {
        const latest = (get()[table] as Rows<any>)[id];
        try {
          const row = await backend().update(table, id, patch, latest.version);
          get().apply({ upserts: [{ table, row }], deletes: [] });
          return row;
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
          // 版本冲突：取回最新数据后按字段判断。对方改的是别的字段 → 在最新版本上重新保存我的修改（自动合并）；
          // 改的是同一字段且内容不同 → 保留对方的版本，提示里提供“用我的内容覆盖”，而不是让我的输入直接丢失
          await get().resync();
          const fresh = (get()[table] as Rows<any>)[id];
          if (!fresh) throw e; // 已被删除
          const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
          const clash = Object.keys(patch).filter((k) => !same(fresh[k], cur[k]) && !same(fresh[k], (patch as any)[k]));
          if (clash.length) {
            get().toast('保存失败：该内容刚被其他成员修改，已显示对方的版本', 'error', {
              label: '用我的内容覆盖',
              run: () => get().updateRow(table, id, patch),
            });
            return null;
          }
          patchLocal(table, id, patch);
          const row = await backend().update(table, id, patch, fresh.version);
          get().apply({ upserts: [{ table, row }], deletes: [] });
          return row;
        }
      });
    },

    async insertRow(table, row) {
      const ws = get().workspace!;
      return mutate('创建', async () => {
        const created = await backend().insert(table, { ...row, workspace_id: ws.id } as any);
        get().apply({ upserts: [{ table, row: created }], deletes: [] });
        return created;
      });
    },

    async removeRow(table, id) {
      await mutate('删除', async () => {
        await backend().remove(table, id);
        await get().resync(); // 删除会级联，直接以快照校准
      }, table === 'events' || table === 'regions' ? 'deleteEvent' : 'edit');
    },

    async createEvent(title, x, y, region_id, quadrant) {
      const ws = get().workspace!;
      const cs = await mutate('创建事件包', () =>
        backend().createEvent({ workspace_id: ws.id, title, x, y, region_id, quadrant, with_default_lists: true }),
      );
      if (!cs) return null;
      get().apply(cs);
      return cs.upserts.find((u) => u.table === 'events')?.row.id ?? null;
    },

    async moveItems(moves, historyLabel) {
      if (!moves.length) return;
      if (!guard('edit')) return;
      const ws = get().workspace!;
      if (historyLabel) {
        const snap = snapshotLayout(historyLabel, moves.map((m) => ({ kind: m.kind, id: m.id })));
        set((s) => ({ layoutHistory: [...s.layoutHistory.slice(-19), snap] }));
      }
      const refresh = freshVersions(moves);
      for (const m of moves) {
        patchLocal(m.kind === 'event' ? 'events' : 'stacks', m.id, {
          x: m.x, y: m.y, region_id: m.region_id, quadrant: m.region_id ? m.quadrant : null,
        });
      }
      // 在写入队列内应用结果（与 updateRow 一致），保证队列中的下一次写入读到的是新版本
      await mutate('移动', async () => {
        const cs = await backend().moveItems(ws.id, refresh());
        get().apply(cs);
        return cs;
      });
    },

    async moveRegion(id, x, y, version) {
      if (!guard('edit')) return;
      const base = version;
      patchLocal('regions', id, { x, y });
      await mutate('移动区域', async () => {
        const cs = await backend().moveRegion(id, x, y, freshVersion(id, base, get().regions[id]?.version));
        get().apply(cs);
        return cs;
      });
    },

    async resizeRegion(id, rect, moves, historyLabel = '调整区域尺寸') {
      if (!guard('edit')) return;
      const r = get().regions[id];
      if (!r) return;
      const refresh = freshVersions(moves);
      const snap = snapshotLayout(historyLabel ?? '', moves.map((m) => ({ kind: m.kind, id: m.id })));
      snap.region = { id, x: r.x, y: r.y, width: r.width, height: r.height };
      patchLocal('regions', id, rect);
      for (const m of moves) {
        patchLocal(m.kind === 'event' ? 'events' : 'stacks', m.id, {
          x: m.x, y: m.y, region_id: m.region_id, quadrant: m.region_id ? m.quadrant : null,
        });
      }
      const cs = await mutate('调整区域', async () => {
        const out = await backend().resizeRegion(id, rect, freshVersion(id, r.version, get().regions[id]?.version), refresh());
        get().apply(out);
        return out;
      });
      if (cs) {
        if (historyLabel) set((s) => ({ layoutHistory: [...s.layoutHistory.slice(-19), snap] }));
      }
    },

    async deleteRegion(id) {
      const cs = await mutate('删除区域', () => backend().deleteRegion(id), 'deleteRegion');
      if (cs) get().apply(cs);
    },

    async createRegion(x, y) {
      const n = Object.keys(get().regions).length + 1;
      await get().insertRow('regions', { name: `四象限区域 ${n}`, x, y, width: 1200, height: 800 });
    },

    async createStack(eventIds) {
      const ws = get().workspace!;
      const problem = validateStack(eventIds.map((id) => get().events[id]).filter(Boolean));
      if (problem) {
        get().toast(`堆叠失败：${problem}`, 'error');
        return;
      }
      const cs = await mutate('堆叠', () => backend().createStack(ws.id, eventIds, null));
      if (cs) get().apply(cs);
    },

    async unstack(stackId) {
      const cs = await mutate('解除堆叠', () => backend().unstack(stackId));
      if (cs) get().apply(cs);
    },

    async setEventStatus(id, status) {
      await get().updateRow('events', id, { status });
    },

    async archiveEvent(id, complete) {
      if (!guard('archive')) return;
      const e = get().events[id];
      if (!e) return;
      patchLocal('events', id, { archived_at: new Date().toISOString() });
      const cs = await mutate('归档', async () => {
        const out = await backend().archiveEvent(id, freshVersion(id, e.version, get().events[id]?.version), complete);
        get().apply(out);
        return out;
      }, 'archive');
      if (cs) {
        if (get().openEventId === id) get().openEvent(null);
        get().toast(`已归档「${e.title}」`, 'success', { label: '撤销', run: () => get().restoreEvent(id) });
      }
    },

    async restoreEvent(id) {
      const cs = await mutate('恢复', () => backend().restoreEvent(id), 'archive');
      if (cs) {
        get().apply(cs);
        // 原位置在归档期间可能已被别的卡片占用：在同一象限内就近挪到空位
        const s = get();
        const e = s.events[id];
        const region = e?.region_id ? s.regions[e.region_id] : null;
        if (e && region && e.quadrant && !e.stack_id && can(s.role, 'edit')) {
          const occupied = [
            ...Object.values(s.events).filter((o) => o.id !== id && o.region_id === region.id && o.quadrant === e.quadrant && !o.archived_at && !o.stack_id),
            ...Object.values(s.stacks).filter((o) => o.region_id === region.id && o.quadrant === e.quadrant),
          ];
          const p = nearestFreeSpot(e, occupied, quadrantRect(region, e.quadrant));
          if (p.x !== e.x || p.y !== e.y) {
            await get().moveItems([{ kind: 'event', id, x: p.x, y: p.y, region_id: region.id, quadrant: e.quadrant, version: e.version }]);
          }
        }
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
      if (last.region) {
        const { id, ...rect } = last.region;
        if (s.regions[id]) await get().resizeRegion(id, rect, moves, null);
      } else {
        await get().moveItems(moves);
      }
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
      if (!guard('edit')) return;
      const t = get().tasks[taskId];
      if (!t) return;
      patchLocal('tasks', taskId, { list_id: listId, position });
      await mutate('移动任务', async () => {
        const latest = get().tasks[taskId];
        const cs = await backend().moveTask(taskId, listId, position, latest.version);
        get().apply(cs); // 在队列内应用，下一次连续拖动读到的是新版本
        return cs;
      });
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
/** 能否编辑：有编辑权限且网络可用（断网时界面进入只读，避免“看起来改了但没保存”） */
export const canEdit = (s: AppState) => s.online && can(s.role, 'edit');
export const canDo = (action: Action) => (s: AppState) => can(s.role, action);

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

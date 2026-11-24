// 本地模式：把浏览器 localStorage 当作“服务端数据库”，BroadcastChannel 当作“实时通道”。
// 每个标签页可以登录不同的本地账户，用来在没有后端时演示多人协作、权限与冲突处理。
// 这里的权限、版本校验与事务逻辑与 supabase/migrations 中的 RPC 保持同一语义。
import {
  TABLES,
  type Activity,
  type AnyRow,
  type ChangeSet,
  type EventPkg,
  type ID,
  type ItemMove,
  type Role,
  type Snapshot,
  type TableName,
  type TableRows,
  type User,
  type Workspace,
  type WorkspaceWithRole,
} from '../../domain/types';
import { fanOut } from '../../domain/layout';
import { can, validateStack, type Action } from '../../domain/rules';
import {
  ConflictError,
  PermissionError,
  type CreateEventInput,
  type PresenceState,
  type RealtimeHandlers,
  type RegionRect,
  type Repo,
  type Subscription,
} from '../repo';

interface Invitation {
  token: string;
  workspace_id: ID;
  email: string | null;
  role: Role;
  expires_at: string;
  accepted_at: string | null;
}

interface DB {
  users: (User & { password: string })[];
  workspaces: Workspace[];
  members: { workspace_id: ID; user_id: ID; role: Role }[];
  invitations: Invitation[];
  activity: Activity[];
  regions: TableRows['regions'][];
  events: TableRows['events'][];
  stacks: TableRows['stacks'][];
  lists: TableRows['lists'][];
  tasks: TableRows['tasks'][];
  checklist_items: TableRows['checklist_items'][];
}

const DB_KEY = 'tessnook:db:v1';
const SESSION_KEY = 'tessnook:session-user';
const RT_CHANNEL = 'tessnook:realtime';
const PRESENCE_CHANNEL = 'tessnook:presence';

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

function emptyDB(): DB {
  return {
    users: [], workspaces: [], members: [], invitations: [], activity: [],
    regions: [], events: [], stacks: [], lists: [], tasks: [], checklist_items: [],
  };
}

function readDB(): DB {
  try {
    const raw = localStorage.getItem(DB_KEY);
    return raw ? { ...emptyDB(), ...JSON.parse(raw) } : emptyDB();
  } catch {
    return emptyDB();
  }
}

function writeDB(db: DB) {
  // 活动日志只保留最近 2000 条
  if (db.activity.length > 2000) db.activity = db.activity.slice(-2000);
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

type RtMessage =
  | { type: 'change'; workspace_id: ID; revision: number; cs: ChangeSet }
  | { type: 'members'; workspace_id: ID };

/** 当前登录身份的存放处。浏览器中默认用 sessionStorage（每个标签页可登录不同账户）；测试中可注入内存实现。 */
export type SessionStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class LocalRepo implements Repo {
  readonly info = { label: '本地模式', storage: 'browser' } as const;
  private session: SessionStore;

  constructor(opts: { session?: SessionStore } = {}) {
    this.session = opts.session ?? sessionStorage;
  }
  private rt = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(RT_CHANNEL) : null;
  /** 本标签页自己写入后各工作空间的修订号，用于区分“自己的写入”与“丢失的消息” */
  private ownRevision = new Map<ID, number>();

  /** 释放广播通道（测试或热重载时使用） */
  dispose() {
    this.rt?.close();
  }

  // ———————————————————— 内部工具 ————————————————————

  private uid(): ID {
    const id = this.session.getItem(SESSION_KEY);
    if (!id) throw new PermissionError('请先登录');
    return id;
  }

  private role(db: DB, ws: ID): Role | null {
    const uid = this.uid();
    return db.members.find((m) => m.workspace_id === ws && m.user_id === uid)?.role ?? null;
  }

  /** 按 domain/rules 的权限矩阵检查 */
  private require(db: DB, ws: ID, action: Action) {
    if (!can(this.role(db, ws), action)) throw new PermissionError();
  }

  /** 读-改-写事务：fn 中修改 db 并返回变更集，统一提升修订号并广播 */
  private tx(ws: ID, fn: (db: DB, cs: ChangeSet) => void): ChangeSet {
    const db = readDB();
    const cs: ChangeSet = { upserts: [], deletes: [] };
    fn(db, cs);
    const w = db.workspaces.find((x) => x.id === ws);
    if (w && (cs.upserts.length || cs.deletes.length)) w.revision += 1;
    writeDB(db);
    if (w) {
      this.ownRevision.set(ws, w.revision);
      this.emit({ type: 'change', workspace_id: ws, revision: w.revision, cs });
    }
    return cs;
  }

  /** 广播给其他标签页；本页的变更已通过返回值直接应用 */
  private emit(m: RtMessage) {
    this.rt?.postMessage(m);
  }

  private log(db: DB, ws: ID, action: string, entity_type: string, entity_id: ID, summary: string) {
    db.activity.push({
      id: uuid(), workspace_id: ws, actor_id: this.session.getItem(SESSION_KEY),
      action, entity_type, entity_id, summary, created_at: now(),
    });
  }

  private find<T extends TableName>(db: DB, table: T, id: ID): TableRows[T] {
    const row = (db[table] as AnyRow[]).find((r) => r.id === id) as TableRows[T] | undefined;
    if (!row) throw new ConflictError('对象不存在或已被删除');
    return row;
  }

  private touch<T extends AnyRow>(row: T, cs: ChangeSet, table: TableName): T {
    row.version += 1;
    row.updated_at = now();
    cs.upserts.push({ table, row: { ...row } });
    return row;
  }

  private checkVersion(row: AnyRow, expected: number) {
    if (row.version !== expected) throw new ConflictError();
  }

  // ———————————————————— 账户 ————————————————————

  async currentUser(): Promise<User | null> {
    const id = this.session.getItem(SESSION_KEY);
    if (!id) return null;
    const u = readDB().users.find((x) => x.id === id);
    return u ? { id: u.id, email: u.email, display_name: u.display_name } : null;
  }

  async signIn(email: string, password: string): Promise<User> {
    const db = readDB();
    const u = db.users.find((x) => x.email.toLowerCase() === email.toLowerCase());
    if (!u || u.password !== password) throw new Error('邮箱或密码错误');
    this.session.setItem(SESSION_KEY, u.id);
    return { id: u.id, email: u.email, display_name: u.display_name };
  }

  async signUp(email: string, password: string, displayName: string): Promise<User> {
    const db = readDB();
    if (db.users.some((x) => x.email.toLowerCase() === email.toLowerCase())) throw new Error('该邮箱已注册');
    const u = { id: uuid(), email, password, display_name: displayName || email.split('@')[0] };
    db.users.push(u);
    writeDB(db);
    this.session.setItem(SESSION_KEY, u.id);
    return { id: u.id, email: u.email, display_name: u.display_name };
  }

  async signOut() {
    this.session.removeItem(SESSION_KEY);
  }

  // ———————————————————— 工作空间 ————————————————————

  async listWorkspaces(): Promise<WorkspaceWithRole[]> {
    const db = readDB();
    const uid = this.uid();
    return db.members
      .filter((m) => m.user_id === uid)
      .map((m) => ({ ...db.workspaces.find((w) => w.id === m.workspace_id)!, role: m.role }))
      .filter((w) => w.id);
  }

  async createWorkspace(name: string): Promise<Workspace> {
    const db = readDB();
    const uid = this.uid();
    const ws: Workspace = { id: uuid(), name, revision: 0, created_by: uid, created_at: now() };
    db.workspaces.push(ws);
    db.members.push({ workspace_id: ws.id, user_id: uid, role: 'owner' });
    // 新空间附带一个默认四象限区域
    db.regions.push({
      id: uuid(), workspace_id: ws.id, name: '近期工作', x: 0, y: 0, width: 1200, height: 800,
      version: 1, created_at: now(), updated_at: now(),
    });
    writeDB(db);
    return ws;
  }

  async renameWorkspace(id: ID, name: string) {
    const db = readDB();
    this.require(db, id, 'renameWorkspace');
    db.workspaces.find((w) => w.id === id)!.name = name;
    writeDB(db);
    this.emit({ type: 'members', workspace_id: id });
  }

  async deleteWorkspace(id: ID) {
    const db = readDB();
    this.require(db, id, 'deleteWorkspace');
    db.workspaces = db.workspaces.filter((w) => w.id !== id);
    db.members = db.members.filter((m) => m.workspace_id !== id);
    for (const t of TABLES) (db as any)[t] = (db[t] as AnyRow[]).filter((r) => r.workspace_id !== id);
    writeDB(db);
    this.emit({ type: 'members', workspace_id: id });
  }

  async loadSnapshot(workspaceId: ID): Promise<Snapshot> {
    const db = readDB();
    const role = this.role(db, workspaceId);
    if (!role) throw new PermissionError('你不是该工作空间的成员');
    const workspace = db.workspaces.find((w) => w.id === workspaceId)!;
    const pick = <T extends TableName>(t: T) =>
      (db[t] as TableRows[T][]).filter((r) => r.workspace_id === workspaceId);
    return {
      workspace,
      role,
      members: db.members
        .filter((m) => m.workspace_id === workspaceId)
        .map((m) => {
          const u = db.users.find((x) => x.id === m.user_id);
          return { ...m, display_name: u?.display_name ?? '?', email: u?.email ?? '' };
        }),
      regions: pick('regions'),
      events: pick('events'),
      stacks: pick('stacks'),
      lists: pick('lists'),
      tasks: pick('tasks'),
      checklist_items: pick('checklist_items'),
    };
  }

  // ———————————————————— 成员 ————————————————————

  async inviteMember(workspaceId: ID, email: string | null, role: Role) {
    const db = readDB();
    this.require(db, workspaceId, 'manageMembers');
    const token = uuid().replace(/-/g, '');
    db.invitations.push({
      token, workspace_id: workspaceId, email, role,
      expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), accepted_at: null,
    });
    writeDB(db);
    return token;
  }

  async acceptInvitation(token: string) {
    const db = readDB();
    const uid = this.uid();
    const inv = db.invitations.find((i) => i.token === token);
    if (!inv || inv.accepted_at) throw new Error('邀请无效或已被使用');
    if (new Date(inv.expires_at) < new Date()) throw new Error('邀请已过期');
    const me = db.users.find((u) => u.id === uid)!;
    if (inv.email && inv.email.toLowerCase() !== me.email.toLowerCase()) throw new Error('该邀请属于其他邮箱');
    if (!db.members.some((m) => m.workspace_id === inv.workspace_id && m.user_id === uid)) {
      db.members.push({ workspace_id: inv.workspace_id, user_id: uid, role: inv.role });
      this.log(db, inv.workspace_id, 'member.joined', 'member', uid, `${me.display_name} 加入了工作空间`);
    }
    inv.accepted_at = now();
    writeDB(db);
    this.emit({ type: 'members', workspace_id: inv.workspace_id });
    return inv.workspace_id;
  }

  async setMemberRole(workspaceId: ID, userId: ID, role: Role) {
    const db = readDB();
    this.require(db, workspaceId, 'manageMembers');
    const m = db.members.find((x) => x.workspace_id === workspaceId && x.user_id === userId);
    if (!m) throw new Error('成员不存在');
    if (m.role === 'owner' && role !== 'owner' && this.ownerCount(db, workspaceId) <= 1)
      throw new Error('工作空间至少需要一个 Owner');
    m.role = role;
    this.log(db, workspaceId, 'member.role_changed', 'member', userId, `成员角色调整为 ${role}`);
    writeDB(db);
    this.emit({ type: 'members', workspace_id: workspaceId });
  }

  async removeMember(workspaceId: ID, userId: ID) {
    const db = readDB();
    if (userId !== this.uid()) this.require(db, workspaceId, 'manageMembers');
    const m = db.members.find((x) => x.workspace_id === workspaceId && x.user_id === userId);
    if (m?.role === 'owner' && this.ownerCount(db, workspaceId) <= 1) throw new Error('不能移除最后一个 Owner');
    db.members = db.members.filter((x) => !(x.workspace_id === workspaceId && x.user_id === userId));
    this.log(db, workspaceId, 'member.removed', 'member', userId, '成员被移除');
    writeDB(db);
    this.emit({ type: 'members', workspace_id: workspaceId });
  }

  private ownerCount(db: DB, ws: ID) {
    return db.members.filter((m) => m.workspace_id === ws && m.role === 'owner').length;
  }

  // ———————————————————— 通用行操作 ————————————————————

  async insert<T extends TableName>(table: T, row: Partial<TableRows[T]> & { workspace_id: ID }) {
    let created!: TableRows[T];
    this.tx(row.workspace_id, (db, cs) => {
      this.require(db, row.workspace_id, 'edit');
      this.checkRefs(db, table, row);
      created = { id: uuid(), version: 1, created_at: now(), updated_at: now(), ...defaults(table), ...row } as TableRows[T];
      (db[table] as AnyRow[]).push(created);
      cs.upserts.push({ table, row: { ...created } });
    });
    return created;
  }

  async update<T extends TableName>(table: T, id: ID, patch: Partial<TableRows[T]>, expectedVersion: number) {
    let updated!: TableRows[T];
    const ws = this.find(readDB(), table, id).workspace_id;
    this.tx(ws, (db, cs) => {
      this.require(db, ws, 'edit');
      const row = this.find(db, table, id);
      this.checkVersion(row, expectedVersion);
      const { id: _i, workspace_id: _w, version: _v, ...safe } = patch as any;
      this.checkRefs(db, table, { ...row, ...safe });
      Object.assign(row, safe);
      if (table === 'events' && 'status' in safe) {
        const e = row as EventPkg;
        this.log(db, ws, e.status === 'completed' ? 'event.completed' : 'event.reopened', 'event', e.id,
          `${e.status === 'completed' ? '完成' : '重新打开'}「${e.title}」`);
      }
      if (table === 'tasks' && 'done' in safe && (row as any).done) {
        this.log(db, ws, 'task.done', 'task', id, `完成任务「${(row as any).title}」`);
      }
      updated = this.touch(row, cs, table) as TableRows[T];
    });
    return updated;
  }

  async remove(table: TableName, id: ID) {
    const row = (readDB()[table] as AnyRow[]).find((r) => r.id === id);
    if (!row) return;
    this.tx(row.workspace_id, (db, cs) => {
      // 永久删除事件包仅 Owner 可执行；看板内的列/任务/清单 Editor 可删除
      // 永久删除事件包/区域记录仅 Owner；看板内容 Editor 可删
      this.require(db, row.workspace_id, table === 'events' || table === 'regions' ? 'deleteEvent' : 'edit');
      this.cascadeDelete(db, table, id, cs);
    });
  }

  private cascadeDelete(db: DB, table: TableName, id: ID, cs: ChangeSet) {
    const drop = (t: TableName, pred: (r: any) => boolean) => {
      const gone = (db[t] as AnyRow[]).filter(pred);
      (db as any)[t] = (db[t] as AnyRow[]).filter((r) => !pred(r));
      gone.forEach((r) => cs.deletes.push({ table: t, id: r.id }));
      return gone;
    };
    if (table === 'events') {
      const e = this.find(db, 'events', id);
      drop('checklist_items', (r) => r.event_id === id);
      drop('tasks', (r) => r.event_id === id);
      drop('lists', (r) => r.event_id === id);
      drop('events', (r) => r.id === id);
      if (e.stack_id) this.dissolveIfSmall(db, e.stack_id, cs);
    } else if (table === 'lists') {
      const taskIds = new Set(db.tasks.filter((t) => t.list_id === id).map((t) => t.id));
      drop('checklist_items', (r) => taskIds.has(r.task_id));
      drop('tasks', (r) => r.list_id === id);
      drop('lists', (r) => r.id === id);
    } else if (table === 'tasks') {
      drop('checklist_items', (r) => r.task_id === id);
      drop('tasks', (r) => r.id === id);
    } else {
      drop(table, (r) => r.id === id);
    }
  }

  /** 防止跨工作空间引用（对应数据库中的复合外键） */
  private checkRefs(db: DB, table: TableName, row: any) {
    const same = (t: TableName, id: ID | null | undefined) => {
      if (!id) return;
      const ref = (db[t] as AnyRow[]).find((r) => r.id === id);
      if (!ref || ref.workspace_id !== row.workspace_id) throw new Error('非法的跨工作空间引用');
    };
    if (table === 'events') { same('regions', row.region_id); same('stacks', row.stack_id); }
    if (table === 'lists') same('events', row.event_id);
    if (table === 'tasks') {
      same('events', row.event_id); same('lists', row.list_id);
      const l = db.lists.find((x) => x.id === row.list_id);
      if (l && l.event_id !== row.event_id) throw new Error('列表不属于该事件包');
    }
    if (table === 'checklist_items') { same('events', row.event_id); same('tasks', row.task_id); }
  }

  // ———————————————————— 事务性操作 ————————————————————

  async createEvent(input: CreateEventInput) {
    return this.tx(input.workspace_id, (db, cs) => {
      this.require(db, input.workspace_id, 'edit');
      const t = now();
      const e: EventPkg = {
        id: uuid(), workspace_id: input.workspace_id, version: 1, created_at: t, updated_at: t,
        title: input.title, description: '', status: 'active', labels: [], color: null, due_date: null,
        region_id: input.region_id, quadrant: input.region_id ? input.quadrant : null,
        x: input.x, y: input.y, stack_id: null, archived_at: null, archived_by: null, created_by: this.uid(),
      };
      this.checkRefs(db, 'events', e);
      db.events.push(e);
      cs.upserts.push({ table: 'events', row: { ...e } });
      if (input.with_default_lists) {
        ['待办', '进行中', '已完成'].forEach((title, i) => {
          const l = { id: uuid(), workspace_id: e.workspace_id, version: 1, created_at: t, updated_at: t,
            event_id: e.id, title, position: (i + 1) * 1024 };
          db.lists.push(l);
          cs.upserts.push({ table: 'lists', row: { ...l } });
        });
      }
      this.log(db, e.workspace_id, 'event.created', 'event', e.id, `创建事件包「${e.title}」`);
    });
  }

  async moveItems(workspaceId: ID, moves: ItemMove[]) {
    return this.tx(workspaceId, (db, cs) => {
      this.require(db, workspaceId, 'edit');
      this.applyMoves(db, workspaceId, moves, cs);
    });
  }

  /** moveItems 的事务体；resizeRegion 在同一事务中复用 */
  private applyMoves(db: DB, workspaceId: ID, moves: ItemMove[], cs: ChangeSet) {
    for (const m of moves) {
      if (m.region_id) {
        const r = db.regions.find((x) => x.id === m.region_id);
        if (!r || r.workspace_id !== workspaceId) throw new Error('目标区域不存在');
      }
      const quadrant = m.region_id ? m.quadrant : null;
      if (m.kind === 'event') {
        const e = this.find(db, 'events', m.id);
        if (e.workspace_id !== workspaceId) throw new PermissionError();
        this.checkVersion(e, m.version);
        if (e.stack_id) throw new Error('堆叠中的事件包需随卡片堆移动');
        Object.assign(e, { x: m.x, y: m.y, region_id: m.region_id, quadrant });
        this.touch(e, cs, 'events');
      } else {
        const s = this.find(db, 'stacks', m.id);
        if (s.workspace_id !== workspaceId) throw new PermissionError();
        this.checkVersion(s, m.version);
        const dx = m.x - s.x, dy = m.y - s.y;
        Object.assign(s, { x: m.x, y: m.y, region_id: m.region_id, quadrant });
        this.touch(s, cs, 'stacks');
        // 成员跟随卡片堆：同步象限归属，并平移坐标（解除堆叠时据此展开）
        for (const e of db.events.filter((x) => x.stack_id === s.id)) {
          Object.assign(e, { x: e.x + dx, y: e.y + dy, region_id: m.region_id, quadrant });
          this.touch(e, cs, 'events');
        }
      }
    }
  }

  async resizeRegion(id: ID, rect: RegionRect, version: number, moves: ItemMove[]) {
    const ws = this.find(readDB(), 'regions', id).workspace_id;
    return this.tx(ws, (db, cs) => {
      this.require(db, ws, 'edit');
      const r = this.find(db, 'regions', id);
      this.checkVersion(r, version);
      if (rect.width < 200 || rect.height < 200) throw new Error('区域尺寸过小');
      Object.assign(r, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      this.touch(r, cs, 'regions');
      this.applyMoves(db, ws, moves, cs);
    });
  }

  async moveRegion(id: ID, x: number, y: number, version: number) {
    const ws = this.find(readDB(), 'regions', id).workspace_id;
    return this.tx(ws, (db, cs) => {
      this.require(db, ws, 'edit');
      const r = this.find(db, 'regions', id);
      this.checkVersion(r, version);
      const dx = x - r.x, dy = y - r.y;
      Object.assign(r, { x, y });
      this.touch(r, cs, 'regions');
      // 区域内的事件包与卡片堆整体跟随，象限归属不变
      for (const e of db.events.filter((e) => e.region_id === id)) {
        e.x += dx; e.y += dy; this.touch(e, cs, 'events');
      }
      for (const s of db.stacks.filter((s) => s.region_id === id)) {
        s.x += dx; s.y += dy; this.touch(s, cs, 'stacks');
      }
    });
  }

  async deleteRegion(id: ID) {
    const ws = this.find(readDB(), 'regions', id).workspace_id;
    return this.tx(ws, (db, cs) => {
      this.require(db, ws, 'deleteRegion');
      for (const e of db.events.filter((e) => e.region_id === id)) {
        e.region_id = null; e.quadrant = null; this.touch(e, cs, 'events');
      }
      for (const s of db.stacks.filter((s) => s.region_id === id)) {
        s.region_id = null; s.quadrant = null; this.touch(s, cs, 'stacks');
      }
      db.regions = db.regions.filter((r) => r.id !== id);
      cs.deletes.push({ table: 'regions', id });
    });
  }

  async createStack(workspaceId: ID, eventIds: ID[], name: string | null) {
    return this.tx(workspaceId, (db, cs) => {
      this.require(db, workspaceId, 'edit');
      const evs = eventIds.map((id) => this.find(db, 'events', id));
      if (evs.some((e) => e.workspace_id !== workspaceId)) throw new PermissionError();
      const invalid = validateStack(evs);
      if (invalid) throw new Error(invalid);
      const top = evs[0];
      const t = now();
      const s = { id: uuid(), workspace_id: workspaceId, version: 1, created_at: t, updated_at: t,
        name, x: top.x, y: top.y, region_id: top.region_id, quadrant: top.quadrant };
      db.stacks.push(s);
      cs.upserts.push({ table: 'stacks', row: { ...s } });
      for (const e of evs) { e.stack_id = s.id; this.touch(e, cs, 'events'); }
    });
  }

  async unstack(stackId: ID) {
    const ws = this.find(readDB(), 'stacks', stackId).workspace_id;
    return this.tx(ws, (db, cs) => {
      this.require(db, ws, 'edit');
      const s = this.find(db, 'stacks', stackId);
      const members = db.events.filter((e) => e.stack_id === stackId);
      const spots = fanOut(members.map((m) => m.id), s);
      for (const e of members) {
        const p = spots.find((x) => x.id === e.id)!;
        Object.assign(e, { stack_id: null, x: p.x, y: p.y, region_id: s.region_id, quadrant: s.quadrant });
        this.touch(e, cs, 'events');
      }
      db.stacks = db.stacks.filter((x) => x.id !== stackId);
      cs.deletes.push({ table: 'stacks', id: stackId });
    });
  }

  /** 卡片堆成员少于 2 个时自动解散 */
  private dissolveIfSmall(db: DB, stackId: ID, cs: ChangeSet) {
    const s = db.stacks.find((x) => x.id === stackId);
    if (!s) return;
    const rest = db.events.filter((e) => e.stack_id === stackId && !e.archived_at);
    if (rest.length >= 2) return;
    for (const e of rest) {
      Object.assign(e, { stack_id: null, x: s.x, y: s.y, region_id: s.region_id, quadrant: s.quadrant });
      this.touch(e, cs, 'events');
    }
    db.stacks = db.stacks.filter((x) => x.id !== stackId);
    cs.deletes.push({ table: 'stacks', id: stackId });
  }

  async moveTask(taskId: ID, listId: ID, position: number, version: number) {
    const ws = this.find(readDB(), 'tasks', taskId).workspace_id;
    return this.tx(ws, (db, cs) => {
      this.require(db, ws, 'edit');
      const t = this.find(db, 'tasks', taskId);
      this.checkVersion(t, version);
      const l = this.find(db, 'lists', listId);
      if (l.event_id !== t.event_id) throw new Error('V1 不支持跨事件包移动任务');
      Object.assign(t, { list_id: listId, position });
      this.touch(t, cs, 'tasks');
    });
  }

  async archiveEvent(eventId: ID, version: number, complete: boolean) {
    const ws = this.find(readDB(), 'events', eventId).workspace_id;
    return this.tx(ws, (db, cs) => {
      this.require(db, ws, 'archive');
      const e = this.find(db, 'events', eventId);
      this.checkVersion(e, version);
      const stackId = e.stack_id;
      Object.assign(e, {
        archived_at: now(), archived_by: this.uid(), stack_id: null,
        status: complete ? 'completed' : e.status,
      });
      if (stackId) {
        const s = db.stacks.find((x) => x.id === stackId);
        if (s) Object.assign(e, { x: s.x, y: s.y });
      }
      this.touch(e, cs, 'events');
      if (stackId) this.dissolveIfSmall(db, stackId, cs);
      this.log(db, ws, 'event.archived', 'event', e.id, `${complete ? '完成并' : ''}归档「${e.title}」`);
    });
  }

  async restoreEvent(eventId: ID) {
    const ws = this.find(readDB(), 'events', eventId).workspace_id;
    return this.tx(ws, (db, cs) => {
      this.require(db, ws, 'archive');
      const e = this.find(db, 'events', eventId);
      if (!e.archived_at) return;
      // 原区域已删除时 region_id 早已被置空；坐标保留，由客户端定位到该位置
      Object.assign(e, { archived_at: null, archived_by: null });
      this.touch(e, cs, 'events');
      this.log(db, ws, 'event.restored', 'event', e.id, `恢复「${e.title}」`);
    });
  }

  async listActivity(workspaceId: ID, limit: number) {
    const db = readDB();
    this.require(db, workspaceId, 'view');
    return db.activity.filter((a) => a.workspace_id === workspaceId).slice(-limit).reverse();
  }

  // ———————————————————— 实时 ————————————————————

  subscribe(workspaceId: ID, h: RealtimeHandlers): Subscription {
    let lastRevision = readDB().workspaces.find((w) => w.id === workspaceId)?.revision ?? 0;
    const onMsg = (m: RtMessage) => {
      if (m.workspace_id !== workspaceId) return;
      if (m.type === 'members') return h.onMembersChanged();
      lastRevision = Math.max(lastRevision, this.ownRevision.get(workspaceId) ?? 0);
      // 修订号出现跳变 → 说明有消息丢失，回退到快照同步；
      // 较旧的消息（与本页写入交错到达）照常应用，由行版本号保证不会回退
      if (m.revision > lastRevision + 1) {
        lastRevision = m.revision;
        return h.onResync();
      }
      lastRevision = Math.max(lastRevision, m.revision);
      h.onChange(m.cs);
    };
    const rtListener = (ev: MessageEvent<RtMessage>) => onMsg(ev.data);
    this.rt?.addEventListener('message', rtListener);

    // 在线状态：心跳广播，超时剔除
    const presence = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(PRESENCE_CHANNEL) : null;
    const tabId = uuid();
    let mine: PresenceState | null = null;
    const peers = new Map<string, { state: PresenceState; ws: ID; at: number }>();
    const publish = () => {
      const t = Date.now();
      for (const [k, v] of peers) if (t - v.at > 8000) peers.delete(k);
      const list = [...peers.values()].filter((p) => p.ws === workspaceId).map((p) => p.state);
      if (mine) list.push(mine);
      h.onPresence(list);
    };
    const beat = () => mine && presence?.postMessage({ tab: tabId, ws: workspaceId, state: mine });
    presence?.addEventListener('message', (ev: MessageEvent) => {
      const d = ev.data;
      if (d.leave) peers.delete(d.tab);
      else peers.set(d.tab, { state: d.state, ws: d.ws, at: Date.now() });
      publish();
    });
    const hb = setInterval(() => { beat(); publish(); }, 3000);

    // 页面重新可见 / 网络恢复时做一次快照校准
    const resync = () => {
      const rev = readDB().workspaces.find((w) => w.id === workspaceId)?.revision ?? 0;
      lastRevision = Math.max(lastRevision, this.ownRevision.get(workspaceId) ?? 0);
      if (rev !== lastRevision) { lastRevision = rev; h.onResync(); }
    };
    window.addEventListener('online', resync);
    document.addEventListener('visibilitychange', resync);

    return {
      track: (state) => { mine = state; beat(); publish(); },
      close: () => {
        this.rt?.removeEventListener('message', rtListener);
        clearInterval(hb);
        presence?.postMessage({ tab: tabId, leave: true });
        presence?.close();
        window.removeEventListener('online', resync);
        document.removeEventListener('visibilitychange', resync);
      },
    };
  }
}

function defaults(table: TableName): Partial<AnyRow> {
  switch (table) {
    case 'regions': return { name: '四象限区域', x: 0, y: 0, width: 1200, height: 800 } as any;
    case 'lists': return { title: '新列表', position: 1024 } as any;
    case 'tasks': return { title: '', description: '', labels: [], due_date: null, assignee_id: null, done: false, position: 1024 } as any;
    case 'checklist_items': return { text: '', done: false, position: 1024 } as any;
    case 'stacks': return { name: null, region_id: null, quadrant: null } as any;
    default: return {};
  }
}

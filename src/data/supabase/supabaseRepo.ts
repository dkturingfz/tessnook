// Supabase 模式：PostgreSQL 为唯一可信数据源，Realtime 负责传播变更，Presence 负责在线状态。
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import {
  TABLES,
  type Activity,
  type ChangeSet,
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

function fail(error: { code?: string; message: string } | null): never | void {
  if (!error) return;
  if (error.code === 'P0409' || error.message.includes('VERSION_CONFLICT')) throw new ConflictError();
  if (error.code === '42501') throw new PermissionError();
  throw new Error(error.message);
}

export class SupabaseRepo implements Repo {
  readonly info = { label: '云端', storage: 'cloud' } as const;
  private sb: SupabaseClient;

  /** persistSession=false 用于测试或服务端场景：同一进程中可并存多个独立登录会话 */
  constructor(url: string, anonKey: string, opts: { persistSession?: boolean } = {}) {
    const persist = opts.persistSession ?? true;
    this.sb = createClient(url, anonKey, {
      auth: persist
        ? { persistSession: true, autoRefreshToken: true }
        : { persistSession: false, autoRefreshToken: false, storageKey: `tessnook-${crypto.randomUUID()}` },
    });
  }

  // ———————————————————— 账户 ————————————————————

  async currentUser(): Promise<User | null> {
    const { data } = await this.sb.auth.getUser();
    if (!data.user) return null;
    const { data: p } = await this.sb.from('profiles').select('*').eq('id', data.user.id).maybeSingle();
    return { id: data.user.id, email: data.user.email ?? '', display_name: p?.display_name ?? data.user.email ?? '' };
  }

  async signIn(email: string, password: string) {
    const { error } = await this.sb.auth.signInWithPassword({ email, password });
    fail(error);
    return (await this.currentUser())!;
  }

  async signUp(email: string, password: string, displayName: string) {
    const { data, error } = await this.sb.auth.signUp({
      email, password, options: { data: { display_name: displayName } },
    });
    fail(error);
    if (!data.session) throw new Error('注册成功，请前往邮箱确认后再登录');
    return (await this.currentUser())!;
  }

  async signOut() {
    await this.sb.auth.signOut();
  }

  // ———————————————————— 工作空间 ————————————————————

  async listWorkspaces(): Promise<WorkspaceWithRole[]> {
    const { data: auth } = await this.sb.auth.getUser();
    const { data, error } = await this.sb
      .from('workspace_members')
      .select('role, workspaces(*)')
      .eq('user_id', auth.user?.id ?? '');
    fail(error);
    return (data ?? []).map((m: any) => ({ ...m.workspaces, role: m.role }));
  }

  async createWorkspace(name: string): Promise<Workspace> {
    const { data, error } = await this.sb.rpc('create_workspace', { p_name: name });
    fail(error);
    return data as Workspace;
  }

  async renameWorkspace(id: ID, name: string) {
    fail((await this.sb.from('workspaces').update({ name }).eq('id', id)).error);
  }

  async deleteWorkspace(id: ID) {
    fail((await this.sb.from('workspaces').delete().eq('id', id)).error);
  }

  async loadSnapshot(workspaceId: ID): Promise<Snapshot> {
    const { data: auth } = await this.sb.auth.getUser();
    const ws = await this.sb.from('workspaces').select('*').eq('id', workspaceId).maybeSingle();
    fail(ws.error);
    if (!ws.data) throw new PermissionError('你不是该工作空间的成员');
    const members = await this.sb
      .from('workspace_members')
      .select('workspace_id, user_id, role, profiles(display_name, email)')
      .eq('workspace_id', workspaceId);
    fail(members.error);
    const tables = await Promise.all(
      TABLES.map((t) => this.sb.from(t).select('*').eq('workspace_id', workspaceId)),
    );
    tables.forEach((r) => fail(r.error));
    const byTable = Object.fromEntries(TABLES.map((t, i) => [t, tables[i].data ?? []]));
    const mapped = (members.data ?? []).map((m: any) => ({
      workspace_id: m.workspace_id, user_id: m.user_id, role: m.role as Role,
      display_name: m.profiles?.display_name ?? '?', email: m.profiles?.email ?? '',
    }));
    const me = mapped.find((m) => m.user_id === auth.user?.id);
    if (!me) throw new PermissionError('你不是该工作空间的成员');
    return { workspace: ws.data, role: me.role, members: mapped, ...(byTable as any) };
  }

  // ———————————————————— 成员 ————————————————————

  async inviteMember(workspaceId: ID, email: string | null, role: Role) {
    const { data, error } = await this.sb.rpc('invite_member', { p_workspace: workspaceId, p_email: email, p_role: role });
    fail(error);
    return data as string;
  }
  async acceptInvitation(token: string) {
    const { data, error } = await this.sb.rpc('accept_invitation', { p_token: token });
    fail(error);
    return data as ID;
  }
  async setMemberRole(workspaceId: ID, userId: ID, role: Role) {
    fail((await this.sb.rpc('set_member_role', { p_workspace: workspaceId, p_user: userId, p_role: role })).error);
  }
  async removeMember(workspaceId: ID, userId: ID) {
    fail((await this.sb.rpc('remove_member', { p_workspace: workspaceId, p_user: userId })).error);
  }

  // ———————————————————— 通用行操作 ————————————————————

  async insert<T extends TableName>(table: T, row: Partial<TableRows[T]> & { workspace_id: ID }) {
    const { data, error } = await this.sb.from(table).insert(row).select().single();
    fail(error);
    return data as TableRows[T];
  }

  async insertMany<T extends TableName>(table: T, rows: (Partial<TableRows[T]> & { workspace_id: ID })[]) {
    if (rows.length === 0) return [];
    // 单条 INSERT 语句：整批原子生效
    const clean = rows.map(({ version: _v, updated_at: _u, ...r }: any) => r);
    const { data, error } = await this.sb.from(table).insert(clean).select();
    fail(error);
    return (data ?? []) as TableRows[T][];
  }

  async update<T extends TableName>(table: T, id: ID, patch: Partial<TableRows[T]>, expectedVersion: number) {
    const { id: _i, workspace_id: _w, version: _v, created_at: _c, updated_at: _u, ...safe } = patch as any;
    // 乐观并发：仅当版本号仍为客户端预期值时才更新；版本由触发器递增
    const { data, error } = await this.sb
      .from(table).update(safe).eq('id', id).eq('version', expectedVersion).select();
    fail(error);
    if (data && data.length > 0) return data[0] as TableRows[T];
    // 0 行更新有两种原因，需要区分以符合契约：版本已变化（冲突）或 RLS 拒绝（无权限/不可见）
    const { data: cur } = await this.sb.from(table).select('version').eq('id', id).maybeSingle();
    if (cur && cur.version !== expectedVersion) throw new ConflictError();
    if (!cur) throw new ConflictError('对象不存在或已被删除');
    throw new PermissionError();
  }

  async remove(table: TableName, id: ID) {
    const { data, error } = await this.sb.from(table).delete().eq('id', id).select('id');
    fail(error);
    if (!data || data.length === 0) throw new PermissionError('无法删除（权限不足或对象已不存在）');
  }

  // ———————————————————— 事务性操作 ————————————————————

  private async rpc(fn: string, args: Record<string, unknown>): Promise<ChangeSet> {
    const { data, error } = await this.sb.rpc(fn, args);
    fail(error);
    return data as ChangeSet;
  }

  createEvent(i: CreateEventInput) {
    return this.rpc('create_event', {
      p_workspace: i.workspace_id, p_title: i.title, p_x: i.x, p_y: i.y,
      p_region: i.region_id, p_quadrant: i.quadrant, p_default_lists: i.with_default_lists,
    });
  }
  moveItems(workspaceId: ID, moves: ItemMove[]) {
    return this.rpc('move_items', { p_workspace: workspaceId, p_moves: moves });
  }
  moveRegion(id: ID, x: number, y: number, version: number) {
    return this.rpc('move_region', { p_region: id, p_x: x, p_y: y, p_version: version });
  }
  async resizeRegion(id: ID, rect: RegionRect, version: number, moves: ItemMove[]): Promise<ChangeSet> {
    const { data, error } = await this.sb.rpc('resize_region', {
      p_region: id, p_x: rect.x, p_y: rect.y, p_width: rect.width, p_height: rect.height, p_version: version, p_moves: moves,
    });
    // 数据库尚未执行 20261124000000_resize_region 迁移时（PGRST202：函数不存在），退回两步操作（非原子）
    if (error?.code === 'PGRST202') {
      const region = await this.update('regions', id, rect, version);
      const cs = moves.length ? await this.moveItems(region.workspace_id, moves) : { upserts: [], deletes: [] };
      return { upserts: [{ table: 'regions', row: region }, ...cs.upserts], deletes: cs.deletes };
    }
    fail(error);
    return data as ChangeSet;
  }
  deleteRegion(id: ID) {
    return this.rpc('delete_region', { p_region: id });
  }
  createStack(workspaceId: ID, eventIds: ID[], name: string | null) {
    return this.rpc('create_stack', { p_workspace: workspaceId, p_event_ids: eventIds, p_name: name });
  }
  unstack(stackId: ID) {
    return this.rpc('unstack', { p_stack: stackId });
  }
  moveTask(taskId: ID, listId: ID, position: number, version: number) {
    return this.rpc('move_task', { p_task: taskId, p_list: listId, p_position: position, p_version: version });
  }
  archiveEvent(eventId: ID, version: number, complete: boolean) {
    return this.rpc('archive_event', { p_event: eventId, p_version: version, p_complete: complete });
  }
  restoreEvent(eventId: ID) {
    return this.rpc('restore_event', { p_event: eventId });
  }

  async listActivity(workspaceId: ID, limit: number): Promise<Activity[]> {
    const { data, error } = await this.sb
      .from('activity_log').select('*').eq('workspace_id', workspaceId)
      .order('created_at', { ascending: false }).limit(limit);
    fail(error);
    return (data ?? []).map((a: any) => ({ ...a, id: String(a.id) }));
  }

  // ———————————————————— 实时 ————————————————————

  subscribe(workspaceId: ID, h: RealtimeHandlers): Subscription {
    const channel: RealtimeChannel = this.sb.channel(`ws:${workspaceId}`, {
      config: { presence: { key: crypto.randomUUID() } },
    });
    const filter = `workspace_id=eq.${workspaceId}`;

    for (const table of TABLES) {
      channel.on('postgres_changes', { event: 'INSERT', schema: 'public', table, filter }, (p) =>
        h.onChange({ upserts: [{ table, row: p.new as any }], deletes: [] }));
      channel.on('postgres_changes', { event: 'UPDATE', schema: 'public', table, filter }, (p) =>
        h.onChange({ upserts: [{ table, row: p.new as any }], deletes: [] }));
      // DELETE 事件不支持过滤；客户端按 id 删除，不存在的 id 会被忽略
      channel.on('postgres_changes', { event: 'DELETE', schema: 'public', table }, (p) => {
        const old = p.old as any;
        if (old?.id && (!old.workspace_id || old.workspace_id === workspaceId))
          h.onChange({ upserts: [], deletes: [{ table, id: old.id }] });
      });
    }
    channel.on('postgres_changes', { event: '*', schema: 'public', table: 'workspace_members', filter }, () =>
      h.onMembersChanged());

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState<PresenceState>();
      h.onPresence(Object.values(state).map((arr) => arr[0]).filter(Boolean));
    });

    let pending: PresenceState | null = null;
    let joinedOnce = false;
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        // 首次订阅之后的每次重连都可能漏掉消息 → 以数据库快照校准
        if (joinedOnce) h.onResync();
        joinedOnce = true;
        if (pending) channel.track(pending);
      }
    });

    const onOnline = () => h.onResync();
    const win = typeof window !== 'undefined' ? window : null;
    win?.addEventListener('online', onOnline);

    return {
      track: (state) => {
        pending = state;
        channel.track(state);
      },
      close: () => {
        win?.removeEventListener('online', onOnline);
        this.sb.removeChannel(channel);
      },
    };
  }
}

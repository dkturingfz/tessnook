// 数据访问接口：前端只依赖这个接口，本地模式和 Supabase 模式各自实现。
import type {
  ChangeSet,
  ID,
  ItemMove,
  Quadrant,
  Role,
  Snapshot,
  TableName,
  TableRows,
  User,
  Workspace,
  WorkspaceWithRole,
} from '../domain/types';

export class ConflictError extends Error {
  constructor(message = '数据已被其他成员修改') {
    super(message);
    this.name = 'ConflictError';
  }
}
export class PermissionError extends Error {
  constructor(message = '没有执行该操作的权限') {
    super(message);
    this.name = 'PermissionError';
  }
}

export interface PresenceState {
  user_id: ID;
  display_name: string;
  open_event_id: ID | null;
}

export interface RealtimeHandlers {
  onChange(cs: ChangeSet): void;
  /** 断线重连或检测到修订号跳变时触发，客户端应重新拉取快照 */
  onResync(): void;
  onPresence(list: PresenceState[]): void;
  /** 工作空间成员/角色变化（含自己被移除） */
  onMembersChanged(): void;
}

export interface Subscription {
  track(state: PresenceState): void;
  close(): void;
}

export interface CreateEventInput {
  workspace_id: ID;
  title: string;
  x: number;
  y: number;
  region_id: ID | null;
  quadrant: Quadrant | null;
  with_default_lists: boolean;
}

export interface Repo {
  readonly mode: 'local' | 'supabase';

  // —— 账户 ——
  currentUser(): Promise<User | null>;
  signIn(email: string, password: string): Promise<User>;
  signUp(email: string, password: string, displayName: string): Promise<User>;
  signOut(): Promise<void>;

  // —— 工作空间 ——
  listWorkspaces(): Promise<WorkspaceWithRole[]>;
  createWorkspace(name: string): Promise<Workspace>;
  renameWorkspace(id: ID, name: string): Promise<void>;
  deleteWorkspace(id: ID): Promise<void>;
  loadSnapshot(workspaceId: ID): Promise<Snapshot>;

  // —— 成员 ——
  inviteMember(workspaceId: ID, email: string | null, role: Role): Promise<string /* token */>;
  acceptInvitation(token: string): Promise<ID /* workspace id */>;
  setMemberRole(workspaceId: ID, userId: ID, role: Role): Promise<void>;
  removeMember(workspaceId: ID, userId: ID): Promise<void>;

  // —— 通用行操作（带乐观并发） ——
  insert<T extends TableName>(table: T, row: Partial<TableRows[T]> & { workspace_id: ID }): Promise<TableRows[T]>;
  /** expectedVersion 不匹配时抛出 ConflictError */
  update<T extends TableName>(table: T, id: ID, patch: Partial<TableRows[T]>, expectedVersion: number): Promise<TableRows[T]>;
  remove(table: TableName, id: ID): Promise<void>;

  // —— 事务性操作 ——
  createEvent(input: CreateEventInput): Promise<ChangeSet>;
  moveItems(workspaceId: ID, moves: ItemMove[]): Promise<ChangeSet>;
  moveRegion(id: ID, x: number, y: number, version: number): Promise<ChangeSet>;
  deleteRegion(id: ID): Promise<ChangeSet>;
  createStack(workspaceId: ID, eventIds: ID[], name: string | null): Promise<ChangeSet>;
  unstack(stackId: ID): Promise<ChangeSet>;
  moveTask(taskId: ID, listId: ID, position: number, version: number): Promise<ChangeSet>;
  archiveEvent(eventId: ID, version: number, complete: boolean): Promise<ChangeSet>;
  restoreEvent(eventId: ID): Promise<ChangeSet>;
  listActivity(workspaceId: ID, limit: number): Promise<import('../domain/types').Activity[]>;

  // —— 实时 ——
  subscribe(workspaceId: ID, handlers: RealtimeHandlers): Subscription;
}

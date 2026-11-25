// 后端契约（数据访问接口）。
//
// 业务模型（src/domain）、画布（src/canvas）、看板（src/board）和状态层（src/store）只依赖这里定义的接口，
// 不依赖任何具体后端。V1 提供两个实现：
//   * src/data/local     —— 浏览器内实现（localStorage + BroadcastChannel），用于离线演示与测试
//   * src/data/supabase  —— Supabase（PostgreSQL + RLS + RPC + Realtime）
// 新的后端（其他数据库服务或自建服务器）只需实现 Repo，并通过 tests/contract 中的契约测试。
//
// 实现必须遵守的语义：
//   * 版本：每个 Versioned 实体在每次修改后 version + 1；带 expectedVersion 的操作在版本不符时抛出 ConflictError。
//   * 权限：按 src/domain/rules.ts 的权限矩阵在服务端（或等价的可信位置）执行，越权抛出 PermissionError。
//   * 事务：CommandApi 中的每个方法要么全部生效，要么全部不生效，并返回实际产生的 ChangeSet。
//   * 隔离：任何对象不得引用其他工作空间的对象。
//   * 实时：其他会话的写入通过 RealtimeHandlers.onChange 推送；可能漏消息时调用 onResync，客户端会重新拉取快照。
import type {
  Activity,
  ChangeSet,
  ID,
  ItemMove,
  PresenceState,
  Quadrant,
  Role,
  Snapshot,
  TableName,
  TableRows,
  User,
  Workspace,
  WorkspaceWithRole,
} from '../domain/types';

export type { PresenceState };

// —————————————————— 错误（所有实现都必须映射到这些类型） ——————————————————

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

// —————————————————— 后端描述（界面只依据能力展示提示，不依据厂商） ——————————————————

export interface BackendInfo {
  /** 展示给用户的名称，例如“本地模式”“云端” */
  label: string;
  /** 数据保存位置：browser = 仅本浏览器；cloud = 服务端 */
  storage: 'browser' | 'cloud';
}

// —————————————————— 端口 ——————————————————

export interface AuthApi {
  currentUser(): Promise<User | null>;
  signIn(email: string, password: string): Promise<User>;
  signUp(email: string, password: string, displayName: string): Promise<User>;
  signOut(): Promise<void>;
}

export interface WorkspaceApi {
  listWorkspaces(): Promise<WorkspaceWithRole[]>;
  createWorkspace(name: string): Promise<Workspace>;
  renameWorkspace(id: ID, name: string): Promise<void>;
  deleteWorkspace(id: ID): Promise<void>;
  /** 一次性读取工作空间的全部业务数据（初次加载与断线校准） */
  loadSnapshot(workspaceId: ID): Promise<Snapshot>;
}

export interface MemberApi {
  /** 返回一次性邀请凭证；email 为空表示任何持有链接的人都可接受 */
  inviteMember(workspaceId: ID, email: string | null, role: Role): Promise<string>;
  /** 返回加入的工作空间 id */
  acceptInvitation(token: string): Promise<ID>;
  setMemberRole(workspaceId: ID, userId: ID, role: Role): Promise<void>;
  removeMember(workspaceId: ID, userId: ID): Promise<void>;
}

/** 单条记录的增删改（带乐观并发） */
export interface RecordApi {
  insert<T extends TableName>(table: T, row: Partial<TableRows[T]> & { workspace_id: ID }): Promise<TableRows[T]>;
  /**
   * 批量插入同一张表的多行（行可以自带 id）。整批是一个事务：任一行无效则全部不生效。
   * 用于从备份导入等场景。
   */
  insertMany<T extends TableName>(table: T, rows: (Partial<TableRows[T]> & { workspace_id: ID })[]): Promise<TableRows[T][]>;
  /** expectedVersion 不匹配时抛出 ConflictError */
  update<T extends TableName>(table: T, id: ID, patch: Partial<TableRows[T]>, expectedVersion: number): Promise<TableRows[T]>;
  /** 级联删除（事件包 → 列表 → 任务 → 检查项） */
  remove(table: TableName, id: ID): Promise<void>;
}

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
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

/** 跨记录的业务命令：每个命令是一个事务 */
export interface CommandApi {
  createEvent(input: CreateEventInput): Promise<ChangeSet>;
  moveItems(workspaceId: ID, moves: ItemMove[]): Promise<ChangeSet>;
  moveRegion(id: ID, x: number, y: number, version: number): Promise<ChangeSet>;
  /**
   * 调整区域位置与尺寸，并在同一事务中应用条目移动（语义同 moveItems，含版本检查）。
   * 条目的新位置由前端按 domain/layout.scaleWithRegion 计算。
   */
  resizeRegion(id: ID, rect: RegionRect, version: number, moves: ItemMove[]): Promise<ChangeSet>;
  deleteRegion(id: ID): Promise<ChangeSet>;
  createStack(workspaceId: ID, eventIds: ID[], name: string | null): Promise<ChangeSet>;
  /** 成员按 domain/layout.fanOut 的规则在卡片堆位置展开 */
  unstack(stackId: ID): Promise<ChangeSet>;
  moveTask(taskId: ID, listId: ID, position: number, version: number): Promise<ChangeSet>;
  archiveEvent(eventId: ID, version: number, complete: boolean): Promise<ChangeSet>;
  restoreEvent(eventId: ID): Promise<ChangeSet>;
  listActivity(workspaceId: ID, limit: number): Promise<Activity[]>;
}

export interface RealtimeHandlers {
  onChange(cs: ChangeSet): void;
  /** 断线重连或检测到消息缺失时触发，客户端应重新拉取快照 */
  onResync(): void;
  onPresence(list: PresenceState[]): void;
  /** 工作空间成员/角色变化（含自己被移除） */
  onMembersChanged(): void;
  /** 实时通道状态（可选）：断开期间仍可通过普通请求读写，恢复后会触发 onResync */
  onStatus?(status: 'connected' | 'reconnecting'): void;
}

export interface Subscription {
  track(state: PresenceState): void;
  close(): void;
}

export interface RealtimeApi {
  subscribe(workspaceId: ID, handlers: RealtimeHandlers): Subscription;
}

/** 完整后端 = 以上全部端口 */
export interface Repo extends AuthApi, WorkspaceApi, MemberApi, RecordApi, CommandApi, RealtimeApi {
  readonly info: BackendInfo;
}

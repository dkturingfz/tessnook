// 业务数据模型 —— 与数据库表一一对应（snake_case），不依赖 React Flow。

export type ID = string;
export type Role = 'owner' | 'editor' | 'viewer';
export type Quadrant = 'Q1' | 'Q2' | 'Q3' | 'Q4';
export type EventStatus = 'active' | 'completed';

export interface User {
  id: ID;
  email: string;
  display_name: string;
}

export interface Workspace {
  id: ID;
  name: string;
  revision: number;
  created_by: ID;
  created_at: string;
}

export interface WorkspaceWithRole extends Workspace {
  role: Role;
}

export interface Member {
  workspace_id: ID;
  user_id: ID;
  role: Role;
  display_name: string;
  email: string;
}

/** 所有可并发修改的业务实体的公共字段 */
export interface Versioned {
  id: ID;
  workspace_id: ID;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface Region extends Versioned {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EventPkg extends Versioned {
  title: string;
  description: string;
  status: EventStatus;
  labels: string[];
  color: string | null;
  due_date: string | null;
  region_id: ID | null;
  quadrant: Quadrant | null;
  x: number;
  y: number;
  stack_id: ID | null;
  archived_at: string | null;
  archived_by: ID | null;
  created_by: ID | null;
}

export interface Stack extends Versioned {
  name: string | null;
  x: number;
  y: number;
  region_id: ID | null;
  quadrant: Quadrant | null;
}

export interface BoardList extends Versioned {
  event_id: ID;
  title: string;
  position: number;
}

export interface Task extends Versioned {
  event_id: ID;
  list_id: ID;
  title: string;
  description: string;
  labels: string[];
  due_date: string | null;
  assignee_id: ID | null;
  done: boolean;
  position: number;
}

export interface ChecklistItem extends Versioned {
  event_id: ID;
  task_id: ID;
  text: string;
  done: boolean;
  position: number;
}

export interface Activity {
  id: ID;
  workspace_id: ID;
  actor_id: ID | null;
  action: string;
  entity_type: string;
  entity_id: ID;
  summary: string;
  created_at: string;
}

export interface TableRows {
  regions: Region;
  events: EventPkg;
  stacks: Stack;
  lists: BoardList;
  tasks: Task;
  checklist_items: ChecklistItem;
}
export type TableName = keyof TableRows;
export const TABLES: TableName[] = ['regions', 'events', 'stacks', 'lists', 'tasks', 'checklist_items'];

export type AnyRow = TableRows[TableName];

/** 一次服务端操作产生的变更集合；RPC 返回它，实时通道也以同样形式推送 */
export interface ChangeSet {
  upserts: { table: TableName; row: AnyRow }[];
  deletes: { table: TableName; id: ID }[];
}

export interface Snapshot {
  workspace: Workspace;
  role: Role;
  members: Member[];
  regions: Region[];
  events: EventPkg[];
  stacks: Stack[];
  lists: BoardList[];
  tasks: Task[];
  checklist_items: ChecklistItem[];
}

/** 画布移动指令：事件包或卡片堆移动到世界坐标，并更新所属区域/象限 */
export interface ItemMove {
  kind: 'event' | 'stack';
  id: ID;
  x: number;
  y: number;
  region_id: ID | null;
  quadrant: Quadrant | null;
  version: number;
}

export const QUADRANT_META: Record<Quadrant, { label: string; hint: string }> = {
  Q1: { label: '重要 · 紧急', hint: '立即处理' },
  Q2: { label: '重要 · 不紧急', hint: '计划推进' },
  Q3: { label: '不重要 · 不紧急', hint: '有空再做' },
  Q4: { label: '不重要 · 紧急', hint: '尽量委派' },
};

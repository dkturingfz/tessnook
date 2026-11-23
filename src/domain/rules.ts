// 业务规则：权限矩阵与堆叠约束。纯函数，不依赖任何后端。
// 前端用它决定界面可用性并做即时校验；每个后端实现必须执行同样的规则（见 tests/contract）。
import type { EventPkg, Role } from './types';

export type Action =
  | 'view'
  | 'edit' // 创建/修改事件包、区域、看板与任务；移动、整理、堆叠
  | 'archive' // 完成、归档、恢复
  | 'deleteRegion' // 删除区域（事件包保留）
  | 'deleteEvent' // 永久删除事件包
  | 'manageMembers' // 邀请成员、修改角色、移除他人
  | 'renameWorkspace'
  | 'deleteWorkspace';

const MATRIX: Record<Action, readonly Role[]> = {
  view: ['owner', 'editor', 'viewer'],
  edit: ['owner', 'editor'],
  archive: ['owner', 'editor'],
  deleteRegion: ['owner', 'editor'],
  deleteEvent: ['owner'],
  manageMembers: ['owner'],
  renameWorkspace: ['owner'],
  deleteWorkspace: ['owner'],
};

export function can(role: Role | null | undefined, action: Action): boolean {
  return !!role && MATRIX[action].includes(role);
}

export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', editor: 'Editor', viewer: 'Viewer' };

export const MIN_STACK_SIZE = 2;

/** 卡片堆只能由同一象限（或同在区域外）的、未归档、未堆叠的事件包组成。返回 null 表示允许。 */
export function validateStack(events: Pick<EventPkg, 'title' | 'region_id' | 'quadrant' | 'archived_at' | 'stack_id'>[]): string | null {
  if (events.length < MIN_STACK_SIZE) return '至少选择两个事件包才能堆叠';
  for (const e of events) {
    if (e.archived_at) return '已归档的事件包不能堆叠';
    if (e.stack_id) return `「${e.title}」已在其他卡片堆中`;
  }
  const key = (e: (typeof events)[number]) => `${e.region_id ?? '-'}|${e.quadrant ?? '-'}`;
  if (new Set(events.map(key)).size > 1) return '只能堆叠同一象限（或同在区域外）的事件包';
  return null;
}

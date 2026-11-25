import { describe, expect, it } from 'vitest';
import { BACKUP_VERSION, backupFileName, planImport, validateBackup, type Backup } from '../src/domain/backup';

const empty = (): Backup => ({ format: 'tessnook-backup', version: 1, exported_at: '', workspace: { name: 'W' }, regions: [], stacks: [], events: [], lists: [], tasks: [], checklist_items: [] });

describe('备份校验', () => {
  it('拒绝非备份文件、过新的版本、缺字段、重复 id 与悬空引用', () => {
    expect(validateBackup(null)).toMatch('不是有效');
    expect(validateBackup({ format: 'x' })).toMatch('不是 Tessnook');
    expect(validateBackup({ ...empty(), version: BACKUP_VERSION + 1 })).toMatch('版本过新');
    expect(validateBackup({ ...empty(), tasks: undefined })).toMatch('缺少 tasks');
    expect(validateBackup({ ...empty(), regions: [{ id: 'a' }, { id: 'a' }] as any })).toMatch('重复的 id');
    expect(validateBackup({ ...empty(), lists: [{ id: 'l', title: '列', event_id: 'nope' }] as any })).toMatch('引用了不存在的事件包');
    expect(validateBackup(empty())).toBeNull();
  });
  it('文件名安全且带日期', () => {
    expect(backupFileName('我的 空间/1', new Date('2026-03-04T10:00:00Z'))).toBe('tessnook-我的-空间-1-2026-03-04.json');
  });
});

describe('导入计划', () => {
  it('按依赖顺序排列，替换全部 id 与引用；负责人只保留导入者', () => {
    const b: Backup = {
      ...empty(),
      regions: [{ id: 'r', name: 'R' } as any],
      events: [{ id: 'e', title: 'E', region_id: 'r', stack_id: null, archived_at: null } as any],
      lists: [{ id: 'l', title: 'L', event_id: 'e' } as any],
      tasks: [{ id: 't1', event_id: 'e', list_id: 'l', assignee_id: 'me' } as any, { id: 't2', event_id: 'e', list_id: 'l', assignee_id: 'other' } as any],
    };
    let n = 0;
    const steps = planImport(b, { workspaceId: 'W2', userId: 'me', newId: () => `n${++n}` });
    expect(steps.map((s) => s.table)).toEqual(['regions', 'stacks', 'events', 'lists', 'tasks', 'checklist_items']);
    const [regions, , events, lists, tasks] = steps.map((s) => s.rows as any[]);
    expect(events[0].region_id).toBe(regions[0].id);
    expect(lists[0].event_id).toBe(events[0].id);
    expect(tasks.map((t) => [t.list_id === lists[0].id, t.assignee_id])).toEqual([[true, 'me'], [true, null]]);
    expect(steps.flatMap((s) => s.rows).every((r: any) => r.workspace_id === 'W2' && r.id.startsWith('n'))).toBe(true);
  });
});

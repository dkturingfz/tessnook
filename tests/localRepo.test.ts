import { beforeEach, describe, expect, it } from 'vitest';
import { resetStorage, switchUser } from './setup-dom';
import { LocalRepo } from '../src/data/localRepo';
import { ConflictError, PermissionError } from '../src/data/repo';

const repo = new LocalRepo();
let alice: string, bob: string, ws: string, region: string;

beforeEach(async () => {
  resetStorage();
  bob = (await repo.signUp('bob@x.com', 'secret1', 'Bob')).id;
  alice = (await repo.signUp('alice@x.com', 'secret1', 'Alice')).id;
  ws = (await repo.createWorkspace('团队')).id;
  region = (await repo.loadSnapshot(ws)).regions[0].id;
});

async function newEvent(title: string, x = 100, y = 100, quadrant: any = 'Q1') {
  const cs = await repo.createEvent({ workspace_id: ws, title, x, y, region_id: region, quadrant, with_default_lists: true });
  return cs.upserts.find((u) => u.table === 'events')!.row as any;
}

describe('LocalRepo（与数据库 RPC 语义一致）', () => {
  it('创建事件包时附带默认三列看板', async () => {
    await newEvent('写论文');
    const snap = await repo.loadSnapshot(ws);
    expect(snap.events).toHaveLength(1);
    expect(snap.lists.map((l) => l.title)).toEqual(['待办', '进行中', '已完成']);
  });

  it('过期版本的修改被拒绝，不会静默覆盖', async () => {
    const e = await newEvent('A');
    await repo.update('events', e.id, { title: 'A1' }, e.version);
    await expect(repo.update('events', e.id, { title: 'A-stale' }, e.version)).rejects.toBeInstanceOf(ConflictError);
    const snap = await repo.loadSnapshot(ws);
    expect(snap.events[0].title).toBe('A1');
  });

  it('堆叠约束：同象限才能堆叠；归档成员后不足两个自动解散', async () => {
    const a = await newEvent('a');
    const b = await newEvent('b', 300);
    const c = await newEvent('c', 800, 700, 'Q4');
    await expect(repo.createStack(ws, [a.id, c.id], null)).rejects.toThrow('同一象限');
    await repo.createStack(ws, [a.id, b.id], null);
    let snap = await repo.loadSnapshot(ws);
    expect(snap.stacks).toHaveLength(1);
    await expect(repo.createStack(ws, [a.id, c.id], null)).rejects.toThrow('已在其他卡片堆中');
    const cur = snap.events.find((e) => e.id === a.id)!;
    await repo.archiveEvent(a.id, cur.version, true);
    snap = await repo.loadSnapshot(ws);
    expect(snap.stacks).toHaveLength(0);
    expect(snap.events.find((e) => e.id === a.id)).toMatchObject({ stack_id: null, status: 'completed' });
    expect(snap.events.find((e) => e.id === b.id)!.stack_id).toBeNull();
  });

  it('移动卡片堆时成员象限跟随', async () => {
    const a = await newEvent('a');
    const b = await newEvent('b', 300);
    const cs = await repo.createStack(ws, [a.id, b.id], null);
    const st = cs.upserts.find((u) => u.table === 'stacks')!.row as any;
    await repo.moveItems(ws, [{ kind: 'stack', id: st.id, x: 900, y: 700, region_id: region, quadrant: 'Q4', version: st.version }]);
    const snap = await repo.loadSnapshot(ws);
    expect(snap.events.every((e) => e.quadrant === 'Q4')).toBe(true);
  });

  it('移动区域时区域内事件包一起平移', async () => {
    const a = await newEvent('a', 100, 100);
    const r = (await repo.loadSnapshot(ws)).regions[0];
    await repo.moveRegion(r.id, 500, 50, r.version);
    const snap = await repo.loadSnapshot(ws);
    expect(snap.events.find((e) => e.id === a.id)).toMatchObject({ x: 600, y: 150, quadrant: 'Q1' });
  });

  it('任务不能移动到其他事件包的列表', async () => {
    const a = await newEvent('a');
    const b = await newEvent('b');
    const snap = await repo.loadSnapshot(ws);
    const la = snap.lists.find((l) => l.event_id === a.id)!;
    const lb = snap.lists.find((l) => l.event_id === b.id)!;
    const t = await repo.insert('tasks', { workspace_id: ws, event_id: a.id, list_id: la.id, title: 't', position: 1 });
    await expect(repo.moveTask(t.id, lb.id, 1, t.version)).rejects.toThrow('跨事件包');
  });

  it('删除区域后事件包保留，归属清空；归档后可恢复', async () => {
    const a = await newEvent('a');
    await repo.deleteRegion(region);
    let snap = await repo.loadSnapshot(ws);
    expect(snap.events[0]).toMatchObject({ region_id: null, quadrant: null, x: 100 });
    await repo.archiveEvent(a.id, snap.events[0].version, false);
    await repo.restoreEvent(a.id);
    snap = await repo.loadSnapshot(ws);
    expect(snap.events[0].archived_at).toBeNull();
  });

  it('权限：非成员无法读取；Viewer 只读；Editor 不能永久删除事件包；最后一个 Owner 不能被移除', async () => {
    const a = await newEvent('a');
    switchUser(bob);
    await expect(repo.loadSnapshot(ws)).rejects.toBeInstanceOf(PermissionError);

    switchUser(alice);
    const token = await repo.inviteMember(ws, 'bob@x.com', 'viewer');
    switchUser(bob);
    await repo.acceptInvitation(token);
    await expect(repo.acceptInvitation(token)).rejects.toThrow('已被使用');
    expect((await repo.loadSnapshot(ws)).role).toBe('viewer');
    await expect(repo.update('events', a.id, { title: 'x' }, a.version)).rejects.toBeInstanceOf(PermissionError);
    await expect(repo.setMemberRole(ws, bob, 'owner')).rejects.toBeInstanceOf(PermissionError);

    switchUser(alice);
    await repo.setMemberRole(ws, bob, 'editor');
    await expect(repo.removeMember(ws, alice)).rejects.toThrow('最后一个 Owner');
    switchUser(bob);
    await repo.update('events', a.id, { title: 'bob' }, a.version);
    await expect(repo.remove('events', a.id)).rejects.toBeInstanceOf(PermissionError);

    switchUser(alice);
    await repo.removeMember(ws, bob);
    switchUser(bob);
    await expect(repo.loadSnapshot(ws)).rejects.toBeInstanceOf(PermissionError);
  });
});

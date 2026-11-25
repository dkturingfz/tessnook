// 后端契约测试：任何 Repo 实现（本地、Supabase、未来的自建后端）都必须通过同一组测试。
// 测试只通过 Repo 接口操作，不接触任何具体数据库，因此也是“如何实现一个新后端”的可执行规范。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EventPkg, ID, Quadrant, Snapshot } from '../../src/domain/types';
import { fanOut, scaleWithRegion } from '../../src/domain/layout';
import { AuthError, ConflictError, PermissionError, type Repo } from '../../src/data/repo';
import { exportBackup, importBackup } from '../../src/store/backup';
import { validateBackup } from '../../src/domain/backup';

export interface ContractHarness {
  name: string;
  /** 返回一个全新的、未登录的后端会话（每个模拟用户一个） */
  newSession(): Repo;
  /** 是否测试实时推送与在线状态（需要该后端的实时通道可用） */
  realtime: boolean;
  dispose?(repo: Repo): void;
  timeout?: number;
}

interface Actor {
  repo: Repo;
  id: ID;
  email: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually(cond: () => boolean, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(50);
  }
  throw new Error(`条件在 ${ms}ms 内未满足`);
}

export function defineRepoContract(h: ContractHarness) {
  const T = h.timeout ?? 10_000;
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const workspaces: { owner: Actor; id: ID }[] = [];
  let alice: Actor, bob: Actor, carol: Actor;

  async function actor(name: string): Promise<Actor> {
    const repo = h.newSession();
    const email = `contract.${run}.${name}@example.com`;
    const u = await repo.signUp(email, `Contract-${run}-pw!`, name);
    return { repo, id: u.id, email };
  }

  /** 每个测试使用自己的工作空间，互不影响，也不需要清空后端 */
  async function workspace() {
    const ws = await alice.repo.createWorkspace(`契约 ${run}`);
    workspaces.push({ owner: alice, id: ws.id });
    const snap = await alice.repo.loadSnapshot(ws.id);
    return { ws: ws.id, region: snap.regions[0].id, snap };
  }

  async function event(ws: ID, region: ID | null, title: string, x = 100, y = 100, q: Quadrant | null = 'Q1') {
    const cs = await alice.repo.createEvent({
      workspace_id: ws, title, x, y, region_id: region, quadrant: q, with_default_lists: true,
    });
    return cs.upserts.find((u) => u.table === 'events')!.row as EventPkg;
  }

  const find = (snap: Snapshot, id: ID) => snap.events.find((e) => e.id === id)!;

  describe(`后端契约：${h.name}`, () => {
    beforeAll(async () => {
      alice = await actor('alice');
      bob = await actor('bob');
      carol = await actor('carol');
    }, T * 3);

    afterAll(async () => {
      for (const w of workspaces) await w.owner.repo.deleteWorkspace(w.id).catch(() => undefined);
      for (const a of [alice, bob, carol]) if (a && h.dispose) h.dispose(a.repo);
    }, T * 3);

    describe('账户与工作空间', () => {
      it('注册后即为登录状态，且带有注册时填写的显示名称', async () => {
        expect(await alice.repo.currentUser()).toMatchObject({ id: alice.id, email: alice.email, display_name: 'alice' });
      }, T);

      it('另一会话用同一账户登录得到同一用户与显示名称；退出登录后为未登录状态', async () => {
        const repo = h.newSession();
        try {
          const u = await repo.signIn(alice.email, `Contract-${run}-pw!`);
          expect(u).toMatchObject({ id: alice.id, email: alice.email, display_name: 'alice' });
          expect(await repo.currentUser()).toMatchObject({ id: alice.id, display_name: 'alice' });
          await repo.signOut();
          expect(await repo.currentUser()).toBeNull();
          // 未登录时，需要登录的操作抛出 AuthError（界面据此回到登录页）
          await expect(repo.listWorkspaces()).rejects.toBeInstanceOf(AuthError);
        } finally {
          if (h.dispose) h.dispose(repo);
        }
      }, T);

      it('创建工作空间：创建者为 Owner，并附带一个默认四象限区域', async () => {
        const { ws, snap } = await workspace();
        expect(snap.role).toBe('owner');
        expect(snap.regions).toHaveLength(1);
        expect(snap.members.map((m) => m.user_id)).toEqual([alice.id]);
        expect((await alice.repo.listWorkspaces()).some((w) => w.id === ws && w.role === 'owner')).toBe(true);
      }, T);

      it('Owner 可以重命名工作空间', async () => {
        const { ws } = await workspace();
        await alice.repo.renameWorkspace(ws, '新名字');
        expect((await alice.repo.loadSnapshot(ws)).workspace.name).toBe('新名字');
      }, T);
    });

    describe('事件包与版本控制', () => {
      it('createEvent 原子地创建事件包与默认三列，返回的变更集与快照一致', async () => {
        const { ws, region } = await workspace();
        const cs = await alice.repo.createEvent({ workspace_id: ws, title: '写论文', x: 10, y: 20, region_id: region, quadrant: 'Q2', with_default_lists: true });
        expect(cs.upserts.map((u) => u.table).sort()).toEqual(['events', 'lists', 'lists', 'lists']);
        const snap = await alice.repo.loadSnapshot(ws);
        expect(snap.events[0]).toMatchObject({ title: '写论文', x: 10, y: 20, region_id: region, quadrant: 'Q2', status: 'active', stack_id: null, archived_at: null, version: 1 });
        expect(snap.lists.sort((a, b) => a.position - b.position).map((l) => l.title)).toEqual(['待办', '进行中', '已完成']);
      }, T);

      it('不在区域中的事件包没有象限', async () => {
        const { ws } = await workspace();
        const e = await event(ws, null, '区域外', 9000, 9000, 'Q3');
        expect(e.quadrant).toBeNull();
      }, T);

      it('每次修改版本号 +1；过期版本的修改抛出 ConflictError，且不覆盖已有数据', async () => {
        const { ws, region } = await workspace();
        const e = await event(ws, region, 'A');
        const r1 = await alice.repo.update('events', e.id, { title: 'A1' }, e.version);
        expect(r1.version).toBe(e.version + 1);
        await expect(alice.repo.update('events', e.id, { title: '过期' }, e.version)).rejects.toBeInstanceOf(ConflictError);
        await expect(alice.repo.moveItems(ws, [{ kind: 'event', id: e.id, x: 0, y: 0, region_id: region, quadrant: 'Q1', version: e.version }]))
          .rejects.toBeInstanceOf(ConflictError);
        expect(find(await alice.repo.loadSnapshot(ws), e.id).title).toBe('A1');
      }, T);

      it('moveItems 更新坐标与象限归属', async () => {
        const { ws, region } = await workspace();
        const e = await event(ws, region, 'A');
        await alice.repo.moveItems(ws, [{ kind: 'event', id: e.id, x: 900, y: 700, region_id: region, quadrant: 'Q4', version: e.version }]);
        expect(find(await alice.repo.loadSnapshot(ws), e.id)).toMatchObject({ x: 900, y: 700, quadrant: 'Q4' });
      }, T);
    });

    describe('区域', () => {
      it('移动区域时，区域内的事件包一起平移，象限不变', async () => {
        const { ws, region, snap } = await workspace();
        const e = await event(ws, region, 'A', 100, 100, 'Q2');
        const r = snap.regions[0];
        await alice.repo.moveRegion(region, r.x + 500, r.y + 50, r.version);
        expect(find(await alice.repo.loadSnapshot(ws), e.id)).toMatchObject({ x: 600, y: 150, quadrant: 'Q2', region_id: region });
      }, T);

      it('调整区域尺寸：区域与条目移动在同一事务中提交', async () => {
        const { ws, region, snap } = await workspace();
        const e = await event(ws, region, 'A', 100, 100, 'Q2');
        const r = snap.regions[0];
        const rect = { x: r.x, y: r.y, width: r.width * 2, height: r.height * 2 };
        const target = scaleWithRegion(e, r, rect);
        const cs = await alice.repo.resizeRegion(region, rect, r.version, [
          { kind: 'event', id: e.id, ...target, region_id: region, quadrant: 'Q2', version: e.version },
        ]);
        expect(cs.upserts.map((u) => u.table).sort()).toEqual(['events', 'regions']);
        const after = await alice.repo.loadSnapshot(ws);
        expect(after.regions[0]).toMatchObject({ width: r.width * 2, height: r.height * 2, version: r.version + 1 });
        expect(find(after, e.id)).toMatchObject({ ...target, quadrant: 'Q2' });
      }, T);

      it('调整区域尺寸时条目可移出区域（撤销缩放时把新纳入的条目还原为自由条目）', async () => {
        const { ws, region, snap } = await workspace();
        const r = snap.regions[0];
        const e = await event(ws, region, 'A', r.x + 100, r.y + 100, 'Q2');
        await alice.repo.resizeRegion(region, { x: r.x, y: r.y, width: r.width - 100, height: r.height }, r.version, [
          { kind: 'event', id: e.id, x: r.x - 400, y: r.y, region_id: null, quadrant: null, version: e.version },
        ]);
        expect(find(await alice.repo.loadSnapshot(ws), e.id)).toMatchObject({ x: r.x - 400, y: r.y, region_id: null, quadrant: null });
      }, T);

      it('调整区域尺寸时任一条目版本过期，则整体不生效', async () => {
        const { ws, region, snap } = await workspace();
        const e = await event(ws, region, 'A', 100, 100, 'Q2');
        await alice.repo.update('events', e.id, { title: 'A2' }, e.version);
        const r = snap.regions[0];
        await expect(alice.repo.resizeRegion(region, { x: r.x, y: r.y, width: r.width + 100, height: r.height }, r.version, [
          { kind: 'event', id: e.id, x: 0, y: 0, region_id: region, quadrant: 'Q2', version: e.version },
        ])).rejects.toBeInstanceOf(ConflictError);
        const after = await alice.repo.loadSnapshot(ws);
        expect(after.regions[0]).toMatchObject({ width: r.width, version: r.version });
        expect(find(after, e.id)).toMatchObject({ x: 100, y: 100 });
      }, T);

      it('新区域默认使用重要性 × 紧急性模板', async () => {
        const { snap } = await workspace();
        expect(snap.regions[0]).toMatchObject({ template: 'eisenhower', axis_config: null });
      }, T);

      it('轴模板：自定义配置可保存并读回；过期版本被拒绝', async () => {
        const { ws, region, snap } = await workspace();
        const r = snap.regions[0];
        const axis_config = { x: '难度', y: '收益', quadrants: { Q1: '硬骨头', Q2: '金矿', Q3: '鸡肋', Q4: '坑' }, urgency_x: true } as const;
        const saved = await alice.repo.update('regions', region, { template: 'custom', axis_config }, r.version);
        expect(saved).toMatchObject({ template: 'custom', axis_config, version: r.version + 1 });
        expect((await alice.repo.loadSnapshot(ws)).regions[0]).toMatchObject({ template: 'custom', axis_config });
        await expect(alice.repo.update('regions', region, { template: 'value_effort', axis_config: null }, r.version)).rejects.toBeInstanceOf(ConflictError);
      }, T);

      it('轴模板：未知模板或缺少自定义配置被拒绝', async () => {
        const { ws, region, snap } = await workspace();
        const r = snap.regions[0];
        await expect(alice.repo.update('regions', region, { template: 'foo' as any }, r.version)).rejects.toThrow();
        await expect(alice.repo.update('regions', region, { template: 'custom', axis_config: null }, r.version)).rejects.toThrow();
        expect((await alice.repo.loadSnapshot(ws)).regions[0]).toMatchObject({ template: 'eisenhower', version: r.version });
      }, T);

      it('删除区域后事件包保留原坐标，区域与象限归属清空', async () => {
        const { ws, region } = await workspace();
        const e = await event(ws, region, 'A', 123, 456);
        await alice.repo.deleteRegion(region);
        const snap = await alice.repo.loadSnapshot(ws);
        expect(snap.regions).toHaveLength(0);
        expect(find(snap, e.id)).toMatchObject({ x: 123, y: 456, region_id: null, quadrant: null });
      }, T);
    });

    describe('堆叠', () => {
      it('只能堆叠同一象限的事件包；同一事件包不能属于两个卡片堆', async () => {
        const { ws, region } = await workspace();
        const a = await event(ws, region, 'a', 100, 100, 'Q1');
        const b = await event(ws, region, 'b', 300, 100, 'Q1');
        const c = await event(ws, region, 'c', 900, 700, 'Q4');
        await expect(alice.repo.createStack(ws, [a.id, c.id], null)).rejects.toThrow();
        await expect(alice.repo.createStack(ws, [a.id], null)).rejects.toThrow();
        await alice.repo.createStack(ws, [a.id, b.id], '论文');
        const snap = await alice.repo.loadSnapshot(ws);
        expect(snap.stacks).toHaveLength(1);
        expect(snap.stacks[0]).toMatchObject({ name: '论文', x: a.x, y: a.y, quadrant: 'Q1' });
        await expect(alice.repo.createStack(ws, [a.id, b.id], null)).rejects.toThrow();
      }, T);

      it('堆叠中的事件包不能单独移动；移动卡片堆时成员的象限跟随', async () => {
        const { ws, region } = await workspace();
        const a = await event(ws, region, 'a');
        const b = await event(ws, region, 'b', 300);
        const st = (await alice.repo.createStack(ws, [a.id, b.id], null)).upserts.find((u) => u.table === 'stacks')!.row;
        const cur = find(await alice.repo.loadSnapshot(ws), a.id);
        await expect(alice.repo.moveItems(ws, [{ kind: 'event', id: a.id, x: 0, y: 0, region_id: region, quadrant: 'Q1', version: cur.version }])).rejects.toThrow();
        await alice.repo.moveItems(ws, [{ kind: 'stack', id: st.id, x: 900, y: 700, region_id: region, quadrant: 'Q4', version: st.version }]);
        const snap = await alice.repo.loadSnapshot(ws);
        expect(snap.events.every((e) => e.quadrant === 'Q4')).toBe(true);
      }, T);

      it('解除堆叠：成员按 domain/layout.fanOut 规则在卡片堆位置展开', async () => {
        const { ws, region } = await workspace();
        const ids = [];
        for (let i = 0; i < 4; i++) ids.push((await event(ws, region, `e${i}`, 100 + i * 10, 100)).id);
        const st = (await alice.repo.createStack(ws, ids, null)).upserts.find((u) => u.table === 'stacks')!.row as any;
        await alice.repo.unstack(st.id);
        const snap = await alice.repo.loadSnapshot(ws);
        expect(snap.stacks).toHaveLength(0);
        const got = snap.events.map((e) => `${e.x},${e.y}`).sort();
        const want = fanOut(ids, st).map((p) => `${p.x},${p.y}`).sort();
        expect(got).toEqual(want);
        expect(snap.events.every((e) => e.stack_id === null && e.quadrant === 'Q1')).toBe(true);
      }, T);
    });

    describe('完成、归档与恢复', () => {
      it('完成并归档：从卡片堆移除；成员不足两个时卡片堆自动解散；恢复后回到画布', async () => {
        const { ws, region } = await workspace();
        const a = await event(ws, region, 'a');
        const b = await event(ws, region, 'b', 300);
        await alice.repo.createStack(ws, [a.id, b.id], null);
        const cur = find(await alice.repo.loadSnapshot(ws), a.id);
        await alice.repo.archiveEvent(a.id, cur.version, true);
        let snap = await alice.repo.loadSnapshot(ws);
        expect(find(snap, a.id)).toMatchObject({ status: 'completed', stack_id: null, archived_by: alice.id });
        expect(find(snap, a.id).archived_at).not.toBeNull();
        expect(snap.stacks).toHaveLength(0);
        expect(find(snap, b.id).stack_id).toBeNull();
        await alice.repo.restoreEvent(a.id);
        snap = await alice.repo.loadSnapshot(ws);
        expect(find(snap, a.id)).toMatchObject({ archived_at: null, status: 'completed' });
      }, T);

      it('归档使用过期版本时抛出 ConflictError', async () => {
        const { ws, region } = await workspace();
        const a = await event(ws, region, 'a');
        await alice.repo.update('events', a.id, { title: 'a2' }, a.version);
        await expect(alice.repo.archiveEvent(a.id, a.version, false)).rejects.toBeInstanceOf(ConflictError);
      }, T);

      it('活动记录包含创建、完成、归档与恢复', async () => {
        const { ws, region } = await workspace();
        const a = await event(ws, region, 'a');
        const done = await alice.repo.update('events', a.id, { status: 'completed' }, a.version);
        await alice.repo.archiveEvent(a.id, done.version, false);
        await alice.repo.restoreEvent(a.id);
        const acts = (await alice.repo.listActivity(ws, 50)).map((x) => x.action);
        for (const act of ['event.created', 'event.completed', 'event.archived', 'event.restored']) expect(acts).toContain(act);
      }, T);
    });

    describe('批量插入', () => {
      it('整批插入并保留给定的 id 与引用；任一行无效则整批不生效', async () => {
        const { ws, region } = await workspace();
        const a = await event(ws, region, 'a');
        const ids = [crypto.randomUUID(), crypto.randomUUID()];
        const rows = await alice.repo.insertMany('lists', ids.map((id, i) => ({ id, workspace_id: ws, event_id: a.id, title: `L${i}`, position: 5000 + i })));
        expect(rows.map((r) => r.id)).toEqual(ids);
        expect(rows.every((r) => r.version === 1)).toBe(true);
        const before = (await alice.repo.loadSnapshot(ws)).lists.length;
        await expect(alice.repo.insertMany('lists', [
          { id: crypto.randomUUID(), workspace_id: ws, event_id: a.id, title: 'ok', position: 1 },
          { id: crypto.randomUUID(), workspace_id: ws, event_id: crypto.randomUUID(), title: '引用不存在的事件包', position: 2 },
        ])).rejects.toThrow();
        expect((await alice.repo.loadSnapshot(ws)).lists.length).toBe(before);
      }, T);

      it('Viewer 不能批量插入', async () => {
        const { ws, region } = await workspace();
        const a = await event(ws, region, 'a');
        await bob.repo.acceptInvitation(await alice.repo.inviteMember(ws, bob.email, 'viewer'));
        await expect(bob.repo.insertMany('lists', [{ workspace_id: ws, event_id: a.id, title: 'x', position: 1 }])).rejects.toThrow();
      }, T);
    });

    describe('备份', () => {
      it('导出后导入为新工作空间：内容与结构一致，id 全部重新生成', async () => {
        const { ws, region, snap } = await workspace();
        await alice.repo.update('regions', region, { name: '源区域', template: 'value_effort' }, snap.regions[0].version);
        const a = await event(ws, region, '甲', 100, 100, 'Q2');
        const b2 = await event(ws, region, '乙', 300, 100, 'Q2');
        const c = await event(ws, null, '区域外', 9000, 9000, null);
        await alice.repo.createStack(ws, [a.id, b2.id], '一堆');
        const l = (await alice.repo.loadSnapshot(ws)).lists.find((x) => x.event_id === c.id)!;
        const t = await alice.repo.insert('tasks', { workspace_id: ws, event_id: c.id, list_id: l.id, title: '任务', position: 1, assignee_id: alice.id, due_date: '2030-01-02' });
        await alice.repo.insert('checklist_items', { workspace_id: ws, event_id: c.id, task_id: t.id, text: '检查项', position: 1, done: true });
        const cv = (await alice.repo.loadSnapshot(ws)).events.find((e) => e.id === c.id)!;
        await alice.repo.archiveEvent(c.id, cv.version, true);

        const backup = await exportBackup(alice.repo, ws);
        expect(validateBackup(JSON.parse(JSON.stringify(backup)))).toBeNull();
        const newWs = await importBackup(alice.repo, backup, { userId: alice.id, name: '导入的空间' });
        workspaces.push({ owner: alice, id: newWs });
        const src = await alice.repo.loadSnapshot(ws);
        const dst = await alice.repo.loadSnapshot(newWs);

        expect(dst.workspace.name).toBe('导入的空间');
        for (const k of ['regions', 'stacks', 'events', 'lists', 'tasks', 'checklist_items'] as const) expect(dst[k].length).toBe(src[k].length);
        const srcIds = new Set(['regions', 'stacks', 'events', 'lists', 'tasks', 'checklist_items'].flatMap((k) => (src as any)[k].map((r: any) => r.id)));
        expect(['regions', 'stacks', 'events', 'lists', 'tasks', 'checklist_items'].flatMap((k) => (dst as any)[k]).some((r: any) => srcIds.has(r.id))).toBe(false);
        expect(dst.regions[0]).toMatchObject({ name: '源区域', template: 'value_effort' });
        const shape = (sn: typeof src) => sn.events.map((e) => ({
          title: e.title, x: e.x, y: e.y, quadrant: e.quadrant, inRegion: !!e.region_id, status: e.status, archived: !!e.archived_at,
          stack: e.stack_id ? sn.stacks.find((s) => s.id === e.stack_id)!.name : null,
          lists: sn.lists.filter((x) => x.event_id === e.id).map((x) => x.title).sort(),
          tasks: sn.tasks.filter((x) => x.event_id === e.id).map((x) => `${x.title}@${sn.lists.find((y) => y.id === x.list_id)!.title}:${x.due_date}:${x.assignee_id ? 'me' : '-'}`),
          checklist: sn.checklist_items.filter((x) => x.event_id === e.id).map((x) => `${x.text}:${x.done}`),
        })).sort((p, q) => p.title.localeCompare(q.title));
        expect(shape(dst)).toEqual(shape(src));
        expect(dst.events.find((e) => e.title === '区域外')).toMatchObject({ archived_by: alice.id, status: 'completed' });
      }, T * 4);

      it('无效的备份不会创建任何工作空间', async () => {
        const before = (await alice.repo.listWorkspaces()).length;
        const bad = { format: 'tessnook-backup', version: 1, exported_at: '', workspace: { name: 'x' }, regions: [], stacks: [], lists: [], tasks: [], checklist_items: [],
          events: [{ id: 'e1', title: '坏', region_id: 'missing', stack_id: null }] } as any;
        await expect(importBackup(alice.repo, bad, { userId: alice.id, name: 'x' })).rejects.toThrow('引用了不存在的区域');
        expect((await alice.repo.listWorkspaces()).length).toBe(before);
      }, T);
    });

    describe('看板', () => {
      it('任务可在同一事件包的列表间移动，不能移动到其他事件包的列表', async () => {
        const { ws, region } = await workspace();
        const a = await event(ws, region, 'a');
        const b = await event(ws, region, 'b');
        const snap = await alice.repo.loadSnapshot(ws);
        const la = snap.lists.filter((l) => l.event_id === a.id).sort((x, y) => x.position - y.position);
        const lb = snap.lists.find((l) => l.event_id === b.id)!;
        const t = await alice.repo.insert('tasks', { workspace_id: ws, event_id: a.id, list_id: la[0].id, title: '查文献', position: 1024 });
        const moved = (await alice.repo.moveTask(t.id, la[1].id, 2048, t.version)).upserts[0].row as any;
        expect(moved).toMatchObject({ list_id: la[1].id, position: 2048, version: t.version + 1 });
        await expect(alice.repo.moveTask(t.id, lb.id, 1, moved.version)).rejects.toThrow();
        await expect(alice.repo.moveTask(t.id, la[0].id, 1, t.version)).rejects.toBeInstanceOf(ConflictError);
      }, T);

      it('永久删除事件包会级联删除其列表、任务与检查项', async () => {
        const { ws, region } = await workspace();
        const a = await event(ws, region, 'a');
        const l = (await alice.repo.loadSnapshot(ws)).lists[0];
        const t = await alice.repo.insert('tasks', { workspace_id: ws, event_id: a.id, list_id: l.id, title: 't', position: 1 });
        await alice.repo.insert('checklist_items', { workspace_id: ws, event_id: a.id, task_id: t.id, text: 'c', position: 1 });
        await alice.repo.remove('events', a.id);
        const snap = await alice.repo.loadSnapshot(ws);
        expect([snap.events, snap.lists, snap.tasks, snap.checklist_items].map((x) => x.length)).toEqual([0, 0, 0, 0]);
      }, T);
    });

    describe('成员与权限（规则见 src/domain/rules.ts）', () => {
      it('非成员无法读取或写入工作空间', async () => {
        const { ws, region } = await workspace();
        await event(ws, region, 'a');
        await expect(carol.repo.loadSnapshot(ws)).rejects.toBeInstanceOf(PermissionError);
        await expect(carol.repo.createEvent({ workspace_id: ws, title: 'x', x: 0, y: 0, region_id: null, quadrant: null, with_default_lists: false }))
          .rejects.toBeInstanceOf(PermissionError);
        expect((await carol.repo.listWorkspaces()).some((w) => w.id === ws)).toBe(false);
      }, T);

      it('邀请只能由指定邮箱接受，且只能使用一次', async () => {
        const { ws } = await workspace();
        const token = await alice.repo.inviteMember(ws, bob.email, 'viewer');
        await expect(carol.repo.acceptInvitation(token)).rejects.toThrow();
        expect(await bob.repo.acceptInvitation(token)).toBe(ws);
        await expect(bob.repo.acceptInvitation(token)).rejects.toThrow();
        expect((await bob.repo.loadSnapshot(ws)).role).toBe('viewer');
      }, T);

      it('不指定邮箱的邀请可以被任何登录用户接受', async () => {
        const { ws } = await workspace();
        const token = await alice.repo.inviteMember(ws, null, 'editor');
        expect(await carol.repo.acceptInvitation(token)).toBe(ws);
        expect((await carol.repo.loadSnapshot(ws)).role).toBe('editor');
      }, T);

      it('Viewer 只能读：修改、创建、归档、管理成员都抛出 PermissionError', async () => {
        const { ws, region } = await workspace();
        const a = await event(ws, region, 'a');
        await bob.repo.acceptInvitation(await alice.repo.inviteMember(ws, bob.email, 'viewer'));
        expect((await bob.repo.loadSnapshot(ws)).events).toHaveLength(1);
        await expect(bob.repo.update('events', a.id, { title: 'x' }, a.version)).rejects.toBeInstanceOf(PermissionError);
        await expect(bob.repo.createEvent({ workspace_id: ws, title: 'x', x: 0, y: 0, region_id: null, quadrant: null, with_default_lists: false }))
          .rejects.toBeInstanceOf(PermissionError);
        await expect(bob.repo.archiveEvent(a.id, a.version, false)).rejects.toBeInstanceOf(PermissionError);
        await expect(bob.repo.setMemberRole(ws, bob.id, 'owner')).rejects.toBeInstanceOf(PermissionError);
        await expect(bob.repo.inviteMember(ws, null, 'editor')).rejects.toBeInstanceOf(PermissionError);
      }, T);

      it('Editor 可以编辑，但不能永久删除事件包或管理成员', async () => {
        const { ws, region } = await workspace();
        const a = await event(ws, region, 'a');
        await bob.repo.acceptInvitation(await alice.repo.inviteMember(ws, bob.email, 'editor'));
        const r = await bob.repo.update('events', a.id, { title: 'Bob 改' }, a.version);
        expect(r.title).toBe('Bob 改');
        await expect(bob.repo.remove('events', a.id)).rejects.toBeInstanceOf(PermissionError);
        await expect(bob.repo.inviteMember(ws, null, 'viewer')).rejects.toBeInstanceOf(PermissionError);
        expect((await alice.repo.loadSnapshot(ws)).events).toHaveLength(1);
      }, T);

      it('最后一个 Owner 不能被降级或移除；成员被移除后立即失去访问权限', async () => {
        const { ws } = await workspace();
        await expect(alice.repo.setMemberRole(ws, alice.id, 'editor')).rejects.toThrow();
        await expect(alice.repo.removeMember(ws, alice.id)).rejects.toThrow();
        await bob.repo.acceptInvitation(await alice.repo.inviteMember(ws, bob.email, 'editor'));
        await alice.repo.removeMember(ws, bob.id);
        await expect(bob.repo.loadSnapshot(ws)).rejects.toBeInstanceOf(PermissionError);
      }, T);

      it('成员可以自行退出', async () => {
        const { ws } = await workspace();
        await bob.repo.acceptInvitation(await alice.repo.inviteMember(ws, bob.email, 'viewer'));
        await bob.repo.removeMember(ws, bob.id);
        expect((await bob.repo.listWorkspaces()).some((w) => w.id === ws)).toBe(false);
      }, T);
    });

    describe.skipIf(!h.realtime)('实时', () => {
      it('其他成员的写入通过 onChange 推送', async () => {
        const { ws, region } = await workspace();
        const a = await event(ws, region, 'a');
        await bob.repo.acceptInvitation(await alice.repo.inviteMember(ws, bob.email, 'viewer'));
        const seen: string[] = [];
        let resyncs = 0;
        const sub = bob.repo.subscribe(ws, {
          onChange: (cs) => cs.upserts.forEach((u) => u.table === 'events' && seen.push((u.row as EventPkg).title)),
          onResync: () => { resyncs++; },
          onPresence: () => {},
          onMembersChanged: () => {},
        });
        try {
          await sleep(1500); // 等待订阅建立
          await alice.repo.update('events', a.id, { title: '实时更新' }, a.version);
          await eventually(() => seen.includes('实时更新') || resyncs > 0);
        } finally {
          sub.close();
        }
      }, T * 2);

      it('在线状态：订阅同一工作空间的成员互相可见', async () => {
        const { ws } = await workspace();
        await bob.repo.acceptInvitation(await alice.repo.inviteMember(ws, bob.email, 'viewer'));
        const seenByAlice = new Set<string>();
        const seenByBob = new Set<string>();
        const handlers = (set: Set<string>) => ({
          onChange: () => {}, onResync: () => {}, onMembersChanged: () => {},
          onPresence: (list: { user_id: string }[]) => { set.clear(); list.forEach((p) => set.add(p.user_id)); },
        });
        const sa = alice.repo.subscribe(ws, handlers(seenByAlice));
        const sb = bob.repo.subscribe(ws, handlers(seenByBob));
        try {
          sa.track({ user_id: alice.id, display_name: 'alice', open_event_id: null });
          sb.track({ user_id: bob.id, display_name: 'bob', open_event_id: null });
          await eventually(() => seenByAlice.has(bob.id) && seenByBob.has(alice.id), 8000);
        } finally {
          sa.close();
          sb.close();
        }
      }, T * 2);
    });
  });
}

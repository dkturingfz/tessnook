// 状态层（store）单元测试：乐观更新、写入串行化、按版本合并、冲突回退、断网/无权限时不产生“未保存的本地修改”。
// 使用浏览器内后端（LocalRepo），不依赖网络。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalRepo, type SessionStore } from '../src/data/local/localRepo';
import { configureBackend, useStore } from '../src/store/store';

class Mem implements SessionStore {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

const repo = new LocalRepo({ session: new Mem() });
const other = new LocalRepo({ session: new Mem() }); // 同一账户的另一个会话，模拟“别人”的并发修改
const S = () => useStore.getState();
let region: string;

async function newEvent(title: string) {
  const id = await S().createEvent(title, 100, 100, region, 'Q2');
  expect(id).toBeTruthy();
  return id!;
}
const lastToast = () => S().toasts[S().toasts.length - 1]?.text ?? '';

beforeAll(async () => {
  configureBackend(repo);
  await S().signUp('store@x.com', 'secret1', 'S');
  await S().createWorkspace('W');
  region = Object.keys(S().regions)[0];
  await other.signIn('store@x.com', 'secret1');
});
afterAll(async () => {
  await S().signOut();
  repo.dispose();
  other.dispose();
});

describe('store', () => {
  it('同一客户端的连续修改按顺序提交，不会与自己冲突', async () => {
    const id = await newEvent('A');
    const v0 = S().events[id].version;
    await Promise.all([S().updateRow('events', id, { title: 'A1' }), S().updateRow('events', id, { title: 'A2' })]);
    expect(S().events[id]).toMatchObject({ title: 'A2', version: v0 + 2 });
    expect(S().toasts.filter((t) => t.kind === 'error')).toHaveLength(0);
  });

  it('合并远端变更时忽略比本地更旧的版本', async () => {
    const id = await newEvent('B');
    const cur = S().events[id];
    S().apply({ upserts: [{ table: 'events', row: { ...cur, title: '旧消息', version: cur.version - 1 } }], deletes: [] });
    expect(S().events[id].title).toBe('B');
    S().apply({ upserts: [{ table: 'events', row: { ...cur, title: '新消息', version: cur.version + 1 } }], deletes: [] });
    expect(S().events[id].title).toBe('新消息');
  });

  it('打开中的事件包被远端删除时关闭看板', async () => {
    const id = await newEvent('C');
    S().openEvent(id);
    S().apply({ upserts: [], deletes: [{ table: 'events', id }] });
    expect(S().openEventId).toBeNull();
  });

  it('冲突：别人先改了，本地的过期修改被拒绝，提示并回到服务端最新数据', async () => {
    const id = await newEvent('D');
    const snap = await other.loadSnapshot(S().workspace!.id);
    const row = snap.events.find((e) => e.id === id)!;
    await other.update('events', id, { title: '别人改的' }, row.version);
    await S().updateRow('events', id, { title: '我改的' });
    expect(lastToast()).toContain('刚被其他成员修改');
    expect(S().events[id].title).toBe('别人改的');
  });

  it('断网时修改被拦下，且本地不残留未保存的修改', async () => {
    const id = await newEvent('E');
    const before = S().events[id];
    useStore.setState({ online: false });
    try {
      await S().updateRow('events', id, { title: '断网时改' });
      await S().moveItems([{ kind: 'event', id, x: 999, y: 999, region_id: region, quadrant: 'Q2', version: before.version }]);
      expect(lastToast()).toContain('网络已断开');
      expect(S().events[id]).toMatchObject({ title: 'E', x: before.x, y: before.y });
    } finally {
      useStore.setState({ online: true });
    }
  });

  it('无编辑权限时修改被拦下，且本地不残留未保存的修改', async () => {
    const id = await newEvent('F');
    useStore.setState({ role: 'viewer' });
    try {
      await S().updateRow('events', id, { title: 'Viewer 改' });
      await S().archiveEvent(id, false);
      expect(lastToast()).toContain('只读');
      expect(S().events[id]).toMatchObject({ title: 'F', archived_at: null });
    } finally {
      useStore.setState({ role: 'owner' });
    }
  });

  it('撤销整理：恢复到整理前的位置', async () => {
    const id = await newEvent('G');
    const before = S().events[id];
    await S().moveItems([{ kind: 'event', id, x: 500, y: 300, region_id: region, quadrant: 'Q2', version: before.version }], '测试移动');
    expect(S().events[id]).toMatchObject({ x: 500, y: 300 });
    await S().undoLayout();
    expect(S().events[id]).toMatchObject({ x: before.x, y: before.y });
  });

  it('恢复归档时原位置已被占用：就近挪到同一象限的空位', async () => {
    const r = S().regions[region];
    const x = r.x + 60, y = r.y + 80; // 左上象限（Q2）内
    const a = (await S().createEvent('归档的', x, y, region, 'Q2'))!;
    await S().archiveEvent(a, false);
    const b = (await S().createEvent('后来的', x, y, region, 'Q2'))!;
    await S().restoreEvent(a);
    const [ea, eb] = [S().events[a], S().events[b]];
    expect(ea.archived_at).toBeNull();
    expect(ea.quadrant).toBe('Q2');
    expect(Math.abs(ea.x - eb.x) >= 220 || Math.abs(ea.y - eb.y) >= 104).toBe(true);
    expect([eb.x, eb.y]).toEqual([x, y]); // 不动别人的卡片
  });

  it('连续快速移动（前一次尚未保存完）不会被误判为冲突', async () => {
    const id = await newEvent('I');
    const orig = repo.moveItems.bind(repo);
    repo.moveItems = async (...a: Parameters<typeof orig>) => { await new Promise((r) => setTimeout(r, 30)); return orig(...a); }; // 模拟网络延迟
    try {
      const errorsBefore = S().toasts.filter((t) => t.kind === 'error').length;
      const step = () => {
        const e = S().events[id];
        return S().moveItems([{ kind: 'event', id, x: e.x + 16, y: e.y, region_id: region, quadrant: 'Q2', version: e.version }]);
      };
      const x0 = S().events[id].x;
      await Promise.all([step(), step(), step()]);
      expect(S().toasts.filter((t) => t.kind === 'error').map((t) => t.text).slice(errorsBefore)).toEqual([]);
      expect(S().events[id].x).toBe(x0 + 48);
      const saved = (await other.loadSnapshot(S().workspace!.id)).events.find((e) => e.id === id)!;
      expect(saved.x).toBe(x0 + 48);
    } finally {
      repo.moveItems = orig;
    }
  });

  it('改完标题立即归档（标题尚未保存完）不会被误判为冲突', async () => {
    const id = await newEvent('J');
    const orig = repo.update.bind(repo);
    repo.update = async (...a: Parameters<typeof orig>) => { await new Promise((r) => setTimeout(r, 30)); return orig(...a); }; // 模拟网络延迟
    try {
      const n = S().toasts.filter((t) => t.kind === 'error').length;
      await Promise.all([S().updateRow('events', id, { title: 'J2' }), S().archiveEvent(id, true)]);
      expect(S().toasts.filter((t) => t.kind === 'error').map((t) => t.text).slice(n)).toEqual([]);
      expect(S().events[id]).toMatchObject({ title: 'J2', status: 'completed' });
      expect(S().events[id].archived_at).toBeTruthy();
    } finally {
      repo.update = orig;
    }
  });

  it('撤销调整区域尺寸：区域尺寸与区域内条目位置一起恢复，且撤销本身不再进入历史', async () => {
    const id = await newEvent('H');
    const r0 = { ...S().regions[region] };
    const e0 = S().events[id];
    const historyBefore = S().layoutHistory.length;
    const rect = { x: r0.x, y: r0.y, width: r0.width - 200, height: r0.height - 100 };
    await S().resizeRegion(region, rect, [{ kind: 'event', id, x: e0.x - 50, y: e0.y - 20, region_id: region, quadrant: e0.quadrant, version: e0.version }]);
    expect(S().regions[region]).toMatchObject(rect);
    expect(S().layoutHistory).toHaveLength(historyBefore + 1);
    await S().undoLayout();
    expect(S().regions[region]).toMatchObject({ x: r0.x, y: r0.y, width: r0.width, height: r0.height });
    expect(S().events[id]).toMatchObject({ x: e0.x, y: e0.y, quadrant: e0.quadrant });
    expect(S().layoutHistory).toHaveLength(historyBefore);
    expect(lastToast()).toContain('调整区域尺寸');
  });
});

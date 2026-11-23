#!/usr/bin/env node
// 针对真实 Supabase 项目验证云端模式：认证、RLS 隔离、角色权限、事务 RPC、版本冲突、邀请，
// 以及（默认开启）Realtime 实时推送、在线状态和成员移除后的推送撤销。
//
// 用法：
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=eyJ... node scripts/verify-supabase.mjs
//   追加 --skip-realtime 跳过需要 WebSocket 的检查
//
// 前提：已执行 supabase/migrations 中的迁移，并在 Auth 设置里关闭 "Confirm email"（仅测试期间）。
// 每次运行会注册 3 个一次性测试账户（@example.com），并在结束时删除测试工作空间。
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
const SKIP_RT = process.argv.includes('--skip-realtime');
if (!URL || !KEY) {
  console.error('请设置 SUPABASE_URL 和 SUPABASE_ANON_KEY');
  process.exit(2);
}

const run = Date.now().toString(36);
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push([false, name]);
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function ok({ data, error }, what) {
  if (error) throw new Error(`${what}: ${error.code ?? ''} ${error.message}`);
  return data;
}
async function expectError(promise, code, what) {
  const { error } = await promise;
  assert(error, `${what}：预期失败，但成功了`);
  if (code) assert(error.code === code, `${what}：预期错误码 ${code}，实际 ${error.code} ${error.message}`);
}

async function newUser(name) {
  const c = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `tessnook.verify.${run}.${name.toLowerCase()}@example.com`;
  const { data, error } = await c.auth.signUp({
    email, password: `Verify-${run}-pw!`, options: { data: { display_name: name } },
  });
  if (error) throw new Error(`注册 ${name} 失败：${error.message}`);
  if (!data.session) throw new Error('注册后没有会话：请在 Supabase → Authentication → Sign In / Providers → Email 中关闭 "Confirm email"');
  return { c, id: data.user.id, email, name };
}

/** 订阅某工作空间的 events 变更，返回收到的消息列表 */
async function listen(user, ws) {
  const got = [];
  const ch = user.c.channel(`verify:${ws}:${user.name}`, { config: { presence: { key: user.id } } });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: `workspace_id=eq.${ws}` },
    (p) => got.push(p));
  const presence = [];
  ch.on('presence', { event: 'sync' }, () => {
    presence.length = 0;
    presence.push(...Object.keys(ch.presenceState()));
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Realtime 订阅超时（10 秒）')), 10_000);
    ch.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') { clearTimeout(t); resolve(); }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(t); reject(err ?? new Error(status)); }
    });
  });
  await ch.track({ user_id: user.id, display_name: user.name, open_event_id: null });
  return { got, presence, close: () => user.c.removeChannel(ch) };
}
async function waitFor(cond, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(100);
  }
  throw new Error(`${what}：${ms / 1000} 秒内未发生`);
}

console.log(`\nTessnook 云端验证 · ${URL}\n`);
let alice, bob, carol, ws, region, e1, e2, e3, token;
let rtBob = null;

console.log('认证');
await check('注册 3 个测试账户并自动创建 profile', async () => {
  [alice, bob, carol] = [await newUser('Alice'), await newUser('Bob'), await newUser('Carol')];
  const p = ok(await alice.c.from('profiles').select('*').eq('id', alice.id).single(), '读取 profile');
  assert(p.display_name === 'Alice', `profile 名称不对：${p.display_name}`);
});
if (!alice) {
  console.log('\n无法继续：认证失败。');
  process.exit(1);
}

console.log('工作空间与画布 RPC');
await check('create_workspace 创建空间、Owner 成员与默认区域', async () => {
  ws = ok(await alice.c.rpc('create_workspace', { p_name: `验证 ${run}` }), 'create_workspace').id;
  const regions = ok(await alice.c.from('regions').select('*').eq('workspace_id', ws), '读取区域');
  assert(regions.length === 1, `默认区域数量 ${regions.length}`);
  region = regions[0].id;
});
await check('create_event 原子创建事件包与默认三列', async () => {
  const mk = async (t, x, y, q, lists) => ok(await alice.c.rpc('create_event', {
    p_workspace: ws, p_title: t, p_x: x, p_y: y, p_region: q ? region : null, p_quadrant: q, p_default_lists: lists,
  }), 'create_event');
  const cs = await mk('写论文', 100, 100, 'Q1', true);
  assert(cs.upserts.length === 4, `变更集条目 ${cs.upserts.length}`);
  e1 = cs.upserts[0].row;
  e2 = (await mk('做实验', 400, 100, 'Q1', false)).upserts[0].row;
  e3 = (await mk('区域外', 5000, 5000, null, false)).upserts[0].row;
  assert(e3.quadrant === null, '区域外事件的象限应为空');
});
await check('乐观并发：过期版本的更新被拒绝，不会静默覆盖', async () => {
  const r1 = ok(await alice.c.from('events').update({ title: '写论文 v2' }).eq('id', e1.id).eq('version', e1.version).select(), '更新');
  assert(r1.length === 1 && r1[0].version === e1.version + 1, '版本号应递增');
  const r2 = ok(await alice.c.from('events').update({ title: '过期写入' }).eq('id', e1.id).eq('version', e1.version).select(), '过期更新');
  assert(r2.length === 0, '过期版本不应更新成功');
  await expectError(alice.c.rpc('move_items', { p_workspace: ws, p_moves: [
    { kind: 'event', id: e1.id, x: 1, y: 1, region_id: region, quadrant: 'Q1', version: e1.version },
  ] }), 'P0409', 'move_items 过期版本');
  e1 = r1[0];
});
await check('堆叠：跨象限被拒绝；同象限成功；归档成员后自动解散', async () => {
  await expectError(alice.c.rpc('create_stack', { p_workspace: ws, p_event_ids: [e2.id, e3.id], p_name: null }), null, '跨象限堆叠');
  const cs = ok(await alice.c.rpc('create_stack', { p_workspace: ws, p_event_ids: [e1.id, e2.id], p_name: '论文' }), 'create_stack');
  const stack = cs.upserts.find((u) => u.table === 'stacks').row;
  const cur = ok(await alice.c.from('events').select('version').eq('id', e1.id).single(), '读取版本');
  const ar = ok(await alice.c.rpc('archive_event', { p_event: e1.id, p_version: cur.version, p_complete: true }), 'archive_event');
  assert(ar.deletes.some((d) => d.table === 'stacks' && d.id === stack.id), '卡片堆应被解散');
  ok(await alice.c.rpc('restore_event', { p_event: e1.id }), 'restore_event');
});
await check('看板：任务不能移动到其他事件包的列表', async () => {
  const l1 = ok(await alice.c.from('lists').select('*').eq('event_id', e1.id).order('position').limit(1).single(), '读取列表');
  const other = ok(await alice.c.from('lists').insert({ workspace_id: ws, event_id: e2.id, title: '其他', position: 1 }).select().single(), '建列表');
  const t = ok(await alice.c.from('tasks').insert({ workspace_id: ws, event_id: e1.id, list_id: l1.id, title: '查文献', position: 1 }).select().single(), '建任务');
  await expectError(alice.c.rpc('move_task', { p_task: t.id, p_list: other.id, p_position: 1, p_version: t.version }), null, '跨事件包移动');
});
await check('活动记录由触发器自动写入', async () => {
  const a = ok(await alice.c.from('activity_log').select('action').eq('workspace_id', ws), '读取活动');
  for (const act of ['event.created', 'event.archived', 'event.restored']) assert(a.some((x) => x.action === act), `缺少 ${act}`);
});

console.log('隔离与权限');
await check('非成员（Carol）读不到任何数据，也写不进去', async () => {
  assert(ok(await carol.c.from('workspaces').select('id'), '读空间').length === 0, '能看到别人的空间');
  assert(ok(await carol.c.from('events').select('id').eq('workspace_id', ws), '读事件').length === 0, '能看到别人的事件');
  await expectError(carol.c.from('events').insert({ workspace_id: ws, title: 'hack' }), '42501', '非成员插入');
  await expectError(carol.c.rpc('create_event', { p_workspace: ws, p_title: 'x', p_x: 0, p_y: 0, p_region: null, p_quadrant: null, p_default_lists: false }), '42501', '非成员 RPC');
});
await check('未登录（anon）不能调用 RPC', async () => {
  const anon = createClient(URL, KEY, { auth: { persistSession: false } });
  await expectError(anon.rpc('create_workspace', { p_name: 'x' }), null, 'anon 调用');
});
await check('邀请：只能被指定邮箱接受，且只能用一次', async () => {
  token = ok(await alice.c.rpc('invite_member', { p_workspace: ws, p_email: bob.email, p_role: 'viewer' }), 'invite_member');
  await expectError(carol.c.rpc('accept_invitation', { p_token: token }), null, 'Carol 冒用 Bob 的邀请');
  const joined = ok(await bob.c.rpc('accept_invitation', { p_token: token }), 'Bob 接受邀请');
  assert(joined === ws, '加入的空间不对');
  await expectError(bob.c.rpc('accept_invitation', { p_token: token }), null, '重复使用邀请');
  const inv = ok(await alice.c.from('workspace_invitations').select('token_hash').eq('workspace_id', ws), '读邀请');
  assert(inv.every((i) => i.token_hash !== token), '数据库不应保存明文凭证');
});
await check('Viewer（Bob）只能读，不能改，也不能给自己升级', async () => {
  assert(ok(await bob.c.from('events').select('id').eq('workspace_id', ws), '读').length === 3, 'Viewer 应能读到 3 个事件');
  const upd = ok(await bob.c.from('events').update({ title: 'viewer 改' }).eq('workspace_id', ws).select(), '更新');
  assert(upd.length === 0, 'Viewer 不应能更新');
  await expectError(bob.c.rpc('create_event', { p_workspace: ws, p_title: 'x', p_x: 0, p_y: 0, p_region: null, p_quadrant: null, p_default_lists: false }), '42501', 'Viewer 创建');
  await expectError(bob.c.rpc('set_member_role', { p_workspace: ws, p_user: bob.id, p_role: 'owner' }), '42501', 'Viewer 自升级');
});
await check('Editor（Bob）可以编辑，但不能永久删除事件包；最后一个 Owner 不能被移除', async () => {
  ok(await alice.c.rpc('set_member_role', { p_workspace: ws, p_user: bob.id, p_role: 'editor' }), '升为 Editor');
  const upd = ok(await bob.c.from('events').update({ title: 'Bob 改的' }).eq('id', e3.id).select(), '更新');
  assert(upd.length === 1, 'Editor 应能更新');
  const del = ok(await bob.c.from('events').delete().eq('id', e3.id).select(), '删除');
  assert(del.length === 0, 'Editor 不应能永久删除事件包');
  await expectError(alice.c.rpc('remove_member', { p_workspace: ws, p_user: alice.id }), null, '移除最后一个 Owner');
});

if (!SKIP_RT) {
  console.log('实时协作（WebSocket）');
  await check('Realtime：Alice 的修改在 2 秒内推送给 Bob', async () => {
    rtBob = await listen(bob, ws);
    const t0 = Date.now();
    const cur = ok(await alice.c.from('events').select('version').eq('id', e2.id).single(), '读版本');
    ok(await alice.c.from('events').update({ title: `实时 ${run}` }).eq('id', e2.id).eq('version', cur.version).select(), '更新');
    await waitFor(() => rtBob.got.some((p) => p.new?.id === e2.id && p.new?.title === `实时 ${run}`), 5000, 'Bob 收到推送');
    const ms = Date.now() - t0;
    assert(ms < 2000, `推送延迟 ${ms}ms，超过 2 秒`);
    console.log(`      延迟约 ${ms}ms`);
  });
  await check('Presence：双方都能看到对方在线', async () => {
    const shared = `verify:${ws}:presence`;
    const join = async (u) => {
      const ch = u.c.channel(shared, { config: { presence: { key: u.id } } });
      const seen = new Set();
      ch.on('presence', { event: 'sync' }, () => { seen.clear(); Object.keys(ch.presenceState()).forEach((k) => seen.add(k)); });
      await new Promise((res, rej) => ch.subscribe((s) => (s === 'SUBSCRIBED' ? res() : s === 'CHANNEL_ERROR' && rej(new Error(s)))));
      await ch.track({ user_id: u.id });
      return { ch, seen };
    };
    const a = await join(alice);
    const b = await join(bob);
    await waitFor(() => a.seen.has(bob.id) && b.seen.has(alice.id), 5000, '双方互相可见');
    alice.c.removeChannel(a.ch);
    bob.c.removeChannel(b.ch);
  });
  await check('权限撤销：Bob 被移除后不再收到该空间的推送', async () => {
    ok(await alice.c.rpc('remove_member', { p_workspace: ws, p_user: bob.id }), '移除 Bob');
    await sleep(1500);
    const before = rtBob.got.length;
    const cur = ok(await alice.c.from('events').select('version').eq('id', e2.id).single(), '读版本');
    ok(await alice.c.from('events').update({ title: '移除后' }).eq('id', e2.id).eq('version', cur.version).select(), '更新');
    await sleep(3000);
    const leaked = rtBob.got.slice(before).filter((p) => p.new?.title === '移除后');
    assert(leaked.length === 0, '被移除的成员仍收到了推送');
    assert(ok(await bob.c.from('events').select('id').eq('workspace_id', ws), '读').length === 0, '被移除后仍能读取');
  });
  rtBob?.close();
} else {
  console.log('实时协作（已跳过 --skip-realtime）');
  await check('成员移除后立即失去读取权限', async () => {
    ok(await alice.c.rpc('remove_member', { p_workspace: ws, p_user: bob.id }), '移除 Bob');
    assert(ok(await bob.c.from('events').select('id').eq('workspace_id', ws), '读').length === 0, '被移除后仍能读取');
  });
}

console.log('清理');
await check('Owner 删除测试工作空间（级联删除全部数据）', async () => {
  ok(await alice.c.from('workspaces').delete().eq('id', ws).select(), '删除空间');
  assert(ok(await alice.c.from('events').select('id').eq('workspace_id', ws), '读').length === 0, '数据未清理');
});

const failed = results.filter(([p]) => !p);
console.log(`\n${results.length - failed.length}/${results.length} 项通过${failed.length ? '，失败：' + failed.map(([, n]) => n).join('；') : ''}`);
console.log('（测试账户留在 Authentication → Users 中，可在控制台中删除）');
process.exit(failed.length ? 1 : 0);

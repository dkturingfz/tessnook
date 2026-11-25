// 画布性能基准（本地模式）。先运行 npm run dev（端口 5173），再执行：
//   node scripts/bench-canvas.cjs 500
// 输出：加载耗时、拖动 60 次的耗时、松手到稳定的耗时、帧时间 P50/P95、超过 50ms 的长帧数、打开看板耗时、JS 堆内存。
// 参考值（500 个事件包，每个 3 列 4 任务）：帧时间 P95 ≈ 16.8ms，松手到稳定 ≈ 160ms，打开看板 ≈ 220ms。
const N = Number(process.argv[2] || 500);
(async () => {
  const b = await chromium.launch();
  const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto('http://localhost:5173');
  await p.click('text=注册'); await p.fill('input[type=email]', `perf${Date.now()}@x.com`); await p.fill('input[type=password]', 'secret1');
  await p.click('button:has-text("注册并登录")'); await p.click('button:has-text("创建")'); await p.waitForSelector('.region');
  await p.evaluate((N) => {
    const db = JSON.parse(localStorage.getItem('tessnook:db:v1'));
    const ws = db.workspaces[0].id, r = db.regions[0];
    r.width = 6000; r.height = 4000;
    const now = new Date().toISOString(), uid = db.users[0].id;
    const base = { workspace_id: ws, version: 1, created_at: now, updated_at: now };
    for (let i = 0; i < N; i++) {
      const col = i % 25, row = Math.floor(i / 25);
      const x = 40 + col * 236, y = 80 + row * 190;
      const q = (x + 110 >= 3000 ? (y + 66 < 2018 ? 'Q1' : 'Q4') : (y + 66 < 2018 ? 'Q2' : 'Q3'));
      const id = crypto.randomUUID();
      db.events.push({ ...base, id, title: `事件包 ${i}`, description: i % 2 ? '一段描述文字，用来测试两行截断的显示效果' : '', status: 'active',
        labels: i % 3 ? ['标签'] : [], color: null, due_date: i % 7 === 0 ? '2026-11-26' : null, region_id: r.id, quadrant: q, x, y,
        stack_id: null, archived_at: null, archived_by: null, created_by: uid });
      const lists = ['待办', '进行中', '已完成'].map((t, j) => ({ ...base, id: crypto.randomUUID(), event_id: id, title: t, position: (j + 1) * 1024 }));
      db.lists.push(...lists);
      for (let k = 0; k < 4; k++) db.tasks.push({ ...base, id: crypto.randomUUID(), event_id: id, list_id: lists[k % 3].id, title: `任务 ${k}`, description: '', labels: [], due_date: null, assignee_id: null, done: k === 0, position: (k + 1) * 1024 });
    }
    localStorage.setItem('tessnook:db:v1', JSON.stringify(db));
  }, N);
  const t0 = Date.now();
  await p.reload();
  await p.waitForFunction((N) => document.querySelectorAll('[data-testid=event-card]').length >= Math.min(N, 1), N);
  await p.waitForTimeout(500);
  const loadMs = Date.now() - t0;
  const rendered = await p.locator('[data-testid=event-card]').count();
  // 放大到 100% 并定位到左上角，拖动一张卡片
  await p.evaluate(() => 0);
  await p.click('.react-flow__controls-fitview').catch(() => {});
  const card = p.locator('[data-testid=event-card]').first();
  const box = await card.boundingBox();
  await p.evaluate(() => {
    window.__frames = []; let last = performance.now();
    const loop = (t) => { window.__frames.push(t - last); last = t; if (window.__frames.length < 2000 && !window.__stop) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  await p.mouse.move(box.x + 30, box.y + 10); await p.mouse.down();
  const steps = 60;
  const dragStart = Date.now();
  for (let i = 1; i <= steps; i++) await p.mouse.move(box.x + 30 + i * 6, box.y + 10 + i * 3);
  const dragMs = Date.now() - dragStart;
  const tUp = Date.now();
  await p.mouse.up();
  await p.waitForTimeout(50);
  // 拖动结束后到下一帧稳定
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const upMs = Date.now() - tUp;
  const frames = await p.evaluate(() => { window.__stop = true; return window.__frames; });
  const f = frames.slice(2).sort((a, b) => a - b);
  const pct = (q) => f[Math.min(f.length - 1, Math.floor(f.length * q))]?.toFixed(1);
  const long = f.filter((x) => x > 50).length;
  // 打开看板的耗时
  const tOpen = Date.now();
  await p.locator('[data-testid=event-card]').nth(5).click();
  await p.waitForSelector('[data-testid=task-card]');
  const openMs = Date.now() - tOpen;
  const heap = await p.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
  console.log(JSON.stringify({ N, loadMs, rendered, dragMsFor60Moves: dragMs, mouseUpToStableMs: upMs, frameP50: pct(0.5), frameP95: pct(0.95), framesOver50ms: long, openBoardMs: openMs, heapMB: heap }));
  await b.close();
})().catch((e) => { console.error('FAILED', e.message); process.exit(1); });

import { expect, test, type Page } from '@playwright/test';

const db = (p: Page) => p.evaluate(() => JSON.parse(localStorage.getItem('tessnook:db:v1')!));

async function signUp(page: Page, name: string, email: string, url = '/') {
  await page.goto(url);
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.fill('input[placeholder="显示名称"]', name);
  await page.fill('input[type=email]', email);
  await page.fill('input[type=password]', 'secret1');
  await page.getByRole('button', { name: '注册并登录' }).click();
}

async function createAt(page: Page, title: string, fx: number, fy: number) {
  const body = (await page.locator('.region-body').boundingBox())!;
  await page.mouse.dblclick(body.x + body.width * fx, body.y + body.height * fy);
  await page.fill('.draft input', title);
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid=event-card]', { hasText: title })).toBeVisible();
}

const card = (p: Page, t: string) => p.locator('[data-testid=event-card]', { hasText: t });

async function dragBy(page: Page, x: number, y: number, dx: number, dy: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
  await page.mouse.move(x + dx, y + dy, { steps: 5 });
  await page.mouse.up();
}

test('事件包：双击创建、按象限归属、跨象限拖动、看板任务跨列拖动', async ({ page }) => {
  await signUp(page, '小明', 'm@x.com');
  await page.getByRole('button', { name: '创建' }).click();
  await createAt(page, '写论文', 0.25, 0.3);
  await createAt(page, '回邮件', 0.75, 0.75);
  let d = await db(page);
  expect(d.events.map((e: any) => [e.title, e.quadrant])).toEqual([['写论文', 'Q2'], ['回邮件', 'Q4']]);

  const b = (await card(page, '回邮件').boundingBox())!;
  await dragBy(page, b.x + 60, b.y + 20, 0, -250);
  await expect.poll(async () => (await db(page)).events.find((e: any) => e.title === '回邮件').quadrant).toBe('Q1');
  await expect(page.getByTestId('board-panel')).toHaveCount(0); // 拖拽不会误开看板

  await card(page, '写论文').click();
  const lists = page.getByTestId('list-col');
  await expect(lists).toHaveCount(3);
  for (const t of ['查文献', '列提纲']) {
    await lists.nth(0).locator('input.add-task').fill(t);
    await lists.nth(0).locator('input.add-task').press('Enter');
  }
  await expect(page.getByTestId('task-card')).toHaveCount(2);
  const t = (await page.getByTestId('task-card').filter({ hasText: '列提纲' }).boundingBox())!;
  const target = (await lists.nth(1).boundingBox())!;
  await dragBy(page, t.x + 40, t.y + 10, target.x + 100 - (t.x + 40), target.y + 60 - (t.y + 10));
  await expect.poll(async () => {
    const s = await db(page);
    const task = s.tasks.find((x: any) => x.title === '列提纲');
    return s.lists.find((l: any) => l.id === task.list_id).title;
  }).toBe('进行中');
  await expect(card(page, '写论文')).toContainText('0/2');
});

test('多选整理、撤销、堆叠约束与解除堆叠', async ({ page }) => {
  await signUp(page, 'A', 'a@x.com');
  await page.getByRole('button', { name: '创建' }).click();
  await createAt(page, '甲', 0.2, 0.2);
  await createAt(page, '乙', 0.3, 0.35);
  await createAt(page, '丁', 0.8, 0.8);
  const before = (await db(page)).events.map((e: any) => [e.x, e.y]);

  await card(page, '甲').click({ modifiers: ['Shift'] });
  await card(page, '乙').click({ modifiers: ['Shift'] });
  await page.locator('.selection-bar').getByText('网格整理').click();
  await expect.poll(async () => (await db(page)).events.filter((e: any) => e.title !== '丁').map((e: any) => e.y)).toEqual([60, 60]);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await db(page)).events.map((e: any) => [e.x, e.y])).toEqual(before);

  await page.keyboard.press('Escape');
  await card(page, '甲').click({ modifiers: ['Shift'] });
  await card(page, '丁').click({ modifiers: ['Shift'] });
  await page.locator('.selection-bar').getByText('堆叠').click();
  await expect(page.locator('.toast.error')).toContainText('同一象限');

  await page.keyboard.press('Escape');
  await card(page, '甲').click({ modifiers: ['Shift'] });
  await card(page, '乙').click({ modifiers: ['Shift'] });
  await page.locator('.selection-bar').getByText('堆叠').click();
  await expect(page.getByTestId('stack-card')).toContainText('2');
  await page.locator('[data-testid=stack-card] .stack-top').click();
  await page.getByText('解除堆叠').click();
  await expect(page.getByTestId('stack-card')).toHaveCount(0);
  await expect(page.getByTestId('event-card')).toHaveCount(3);
});

test('两个成员实时协作：邀请、在线状态、同步、降为 Viewer、归档与恢复', async ({ context }) => {
  const A = await context.newPage();
  await signUp(A, 'Alice', 'alice@x.com');
  await A.getByRole('button', { name: '创建' }).click();
  await createAt(A, '共享事件', 0.75, 0.3);

  await A.getByTitle('成员与邀请').click();
  await A.fill('.invite input[type=email]', 'bob@x.com');
  await A.getByText('生成邀请链接').click();
  const link = await A.locator('.invite-link code').innerText();
  await A.keyboard.press('Escape');

  const B = await context.newPage();
  await signUp(B, 'Bob', 'bob@x.com', link);
  await expect(card(B, '共享事件')).toBeVisible();
  await expect(B.locator('.role-tag').first()).toHaveText('Editor');

  // B 打开看板 → A 在卡片上看到 B
  await card(B, '共享事件').click();
  await expect(card(A, '共享事件').locator('.viewers .avatar')).toHaveCount(1, { timeout: 8000 });

  // A 加任务 → B 实时看到
  await card(A, '共享事件').click();
  await A.getByTestId('list-col').nth(0).locator('input.add-task').fill('A 的任务');
  await A.getByTestId('list-col').nth(0).locator('input.add-task').press('Enter');
  await expect(B.getByTestId('task-card').filter({ hasText: 'A 的任务' })).toBeVisible();

  // A 把 B 降为 Viewer → B 变为只读
  await A.getByTitle('成员与邀请').click();
  await A.locator('.member-row', { hasText: 'Bob' }).locator('select').selectOption('viewer');
  await A.keyboard.press('Escape');
  await expect(B.locator('.readonly-badge')).toBeVisible();
  await expect(B.locator('input.add-task')).toHaveCount(0);

  // A 完成并归档 → B 画布隐藏；恢复 → B 重新看到
  await A.locator('.board-actions').getByText('完成并归档').click();
  await expect(card(B, '共享事件')).toHaveCount(0);
  await A.getByTestId('open-archive').click();
  await A.getByTestId('archive-row').getByText('恢复').click();
  await expect(card(B, '共享事件')).toBeVisible();
});

test('删除工作空间后回到空间选择页，且没有错误提示', async ({ page }) => {
  await signUp(page, 'D', 'd@x.com');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.locator('.region')).toBeVisible();
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? '我的工作空间' : undefined));
  await page.getByTestId('ws-switch').click();
  await page.getByText('删除工作空间…').click();
  await expect(page.getByText('新建工作空间')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.locator('.toast.error')).toHaveCount(0);
});

test('调整区域尺寸时，区域内事件包等比例移动且象限不变', async ({ page }) => {
  await signUp(page, 'R', 'r@x.com');
  await page.getByRole('button', { name: '创建' }).click();
  await page.locator('.react-flow__controls-zoomout').click();
  await page.locator('.react-flow__controls-zoomout').click();
  await createAt(page, '左上', 0.25, 0.3);
  await createAt(page, '右下', 0.75, 0.75);
  const before = await db(page);
  const h = (await page.locator('.react-flow__resize-control.handle.bottom.right').boundingBox())!;
  await dragBy(page, h.x + h.width / 2, h.y + h.height / 2, 300, 160);
  await expect.poll(async () => (await db(page)).regions[0].width).toBeGreaterThan(before.regions[0].width);
  const after = await db(page);
  const rel = (e: any, r: any) => [(e.x + 110 - r.x) / r.width, (e.y + 30 - r.y - 36) / (r.height - 36)];
  for (const e of after.events) {
    const o = before.events.find((x: any) => x.id === e.id);
    expect(e.quadrant).toBe(o.quadrant);
    const [a, b] = [rel(o, before.regions[0]), rel(e, after.regions[0])];
    expect(Math.abs(a[0] - b[0])).toBeLessThan(0.01);
    expect(Math.abs(a[1] - b[1])).toBeLessThan(0.01);
  }
});

const day = (n: number) => {
  const d = new Date(); d.setDate(d.getDate() + n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

test('轴设置：切换模板与自定义后，象限与坐标轴名称随之改变，卡片位置不变', async ({ page }) => {
  await signUp(page, 'X', 'x@x.com');
  await page.getByRole('button', { name: '创建' }).click();
  await createAt(page, '用户访谈', 0.25, 0.3);
  const before = (await db(page)).events[0];
  await page.getByRole('button', { name: '轴设置' }).click();
  await page.locator('.template-card', { hasText: '价值 × 投入' }).click();
  await page.locator('.modal').getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.quadrant-Q2 .quadrant-label')).toContainText('速赢');
  await expect(page.locator('.axis-x')).toContainText('投入');

  await page.getByRole('button', { name: '轴设置' }).click();
  await page.locator('.template-card', { hasText: '自定义' }).click();
  await page.getByRole('textbox', { name: '横轴名称' }).fill('');
  await expect(page.locator('.modal').getByRole('button', { name: '保存' })).toBeDisabled();
  await page.getByRole('textbox', { name: '横轴名称' }).fill('难度');
  await page.getByRole('textbox', { name: '左上象限名称' }).fill('金矿');
  await page.locator('.modal').getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.quadrant-Q2 .quadrant-label')).toContainText('金矿');
  const after = await db(page);
  expect(after.regions[0]).toMatchObject({ template: 'custom' });
  expect(after.events[0]).toMatchObject({ x: before.x, y: before.y, quadrant: before.quadrant });
});

test('截止日期提醒：临近截止建议移到紧急象限，一键移动可撤销；暂不提醒', async ({ page }) => {
  await signUp(page, 'D', 'dl@x.com');
  await page.getByRole('button', { name: '创建' }).click();
  await createAt(page, '写周报', 0.25, 0.3);
  await card(page, '写周报').click();
  await page.getByRole('button', { name: '详情' }).click();
  await page.locator('.event-details input[type=date]').fill(day(1));
  await page.locator('.board-head').click();
  await page.getByRole('button', { name: '关闭看板' }).click();

  const pill = card(page, '写周报').locator('.alert-pill');
  await expect(pill).toContainText('建议移至 Q1');
  await expect(page.locator('.bell-count')).toHaveText('1');
  await pill.click();
  await expect.poll(async () => (await db(page)).events[0].quadrant).toBe('Q1');
  await expect(card(page, '写周报').locator('.alert-pill')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await db(page)).events[0].quadrant).toBe('Q2');

  await page.getByTestId('alerts-bell').click();
  await page.getByTestId('alert-row').getByRole('button', { name: '暂不提醒' }).click();
  await expect(page.locator('.bell-count')).toHaveCount(0);
  await expect(card(page, '写周报').locator('.alert-pill')).toHaveCount(0);
});

test('备份：导出为文件，再导入为新的工作空间，内容一致', async ({ page }, testInfo) => {
  await signUp(page, 'B', 'bk@x.com');
  await page.getByRole('button', { name: '创建' }).click();
  await createAt(page, '论文', 0.25, 0.3);
  await createAt(page, '报销', 0.75, 0.75);
  await card(page, '论文').click();
  await page.getByTestId('list-col').nth(0).locator('input.add-task').fill('查文献');
  await page.getByTestId('list-col').nth(0).locator('input.add-task').press('Enter');
  await expect(page.getByTestId('task-card')).toHaveCount(1);
  await page.getByRole('button', { name: '关闭看板' }).click();

  await page.getByTestId('ws-switch').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '导出备份' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^tessnook-.*\.json$/);
  const file = testInfo.outputPath('backup.json');
  await download.saveAs(file);

  page.once('dialog', (d) => d.accept());
  await page.getByTestId('ws-switch').click();
  await page.getByTestId('import-backup-input').setInputFiles(file);
  await expect(page.getByTestId('ws-switch')).toContainText('我的工作空间（导入）');
  await expect(card(page, '论文')).toBeVisible();
  await expect(card(page, '报销')).toBeVisible();
  const d = await db(page);
  expect(d.workspaces).toHaveLength(2);
  const newWs = d.workspaces.find((w: any) => w.name.endsWith('（导入）'));
  const evs = d.events.filter((e: any) => e.workspace_id === newWs.id);
  expect(evs.map((e: any) => [e.title, e.quadrant]).sort()).toEqual([['报销', 'Q4'], ['论文', 'Q2']]);
  expect(d.tasks.filter((t: any) => t.workspace_id === newWs.id).map((t: any) => t.title)).toEqual(['查文献']);
});

test('断网时显示提示并暂停编辑，恢复后自动同步并可继续编辑', async ({ page, context }) => {
  await signUp(page, 'N', 'net@x.com');
  await page.getByRole('button', { name: '创建' }).click();
  await createAt(page, '在线时创建', 0.25, 0.3);
  const node = page.locator('.react-flow__node-event', { hasText: '在线时创建' });
  await expect(node).toHaveClass(/draggable/);

  await context.setOffline(true);
  await expect(page.getByTestId('conn-banner')).toContainText('网络已断开');
  await expect(node).not.toHaveClass(/draggable/);
  await expect(page.locator('.readonly-badge')).toHaveCount(0); // 不是 Viewer，不显示错误的“只读（Viewer）”标记
  const body = (await page.locator('.region-body').boundingBox())!;
  await page.mouse.dblclick(body.x + body.width * 0.75, body.y + body.height * 0.75);
  await expect(page.locator('.draft input')).toHaveCount(0); // 断网时不能新建

  await context.setOffline(false);
  await expect(page.getByTestId('conn-banner')).toHaveCount(0);
  await expect(page.locator('.toast', { hasText: '网络已恢复' })).toBeVisible();
  await expect(node).toHaveClass(/draggable/);
  await createAt(page, '恢复后创建', 0.75, 0.75);
});

test('无障碍：主要界面没有 WCAG A/AA 违规（浅色与深色）；任务可用键盘打开', async ({ browser }) => {
  const { AxeBuilder } = await import('@axe-core/playwright');
  for (const colorScheme of ['light', 'dark'] as const) {
    const ctx = await browser.newContext({ colorScheme, viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const check = async (include?: string) => {
      let b = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
      if (include) b = b.include(include);
      const r = await b.analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
    };
    await page.goto('/');
    await check();
    await signUp(page, 'A', `a11y-${colorScheme}@x.com`);
    await check();
    await page.getByRole('button', { name: '创建' }).click();
    await createAt(page, '写周报', 0.25, 0.3);
    await card(page, '写周报').click();
    await page.getByTestId('list-col').nth(0).locator('input.add-task').fill('查文献');
    await page.getByTestId('list-col').nth(0).locator('input.add-task').press('Enter');
    await check();
    // 键盘：聚焦任务标题按钮，回车打开详情
    await page.getByRole('button', { name: '查文献', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: '任务详情' })).toBeVisible();
    await check('.task-detail');
    await ctx.close();
  }
});

test('新手引导与快捷键：开始提示、N 新建、? 说明、/ 搜索、Esc 由近及远关闭', async ({ page }) => {
  await signUp(page, 'K', 'kb@x.com');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByTestId('start-hint')).toContainText('双击画布');

  await page.locator('.react-flow__pane').click();
  await page.keyboard.press('n');
  await page.locator('.draft input').fill('键盘新建');
  await page.keyboard.press('Enter');
  await expect(card(page, '键盘新建')).toBeVisible();
  await expect(page.getByTestId('start-hint')).toHaveCount(0);

  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: '快捷键与操作说明' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '快捷键与操作说明' })).toHaveCount(0);

  await page.keyboard.press('/');
  await expect(page.getByTestId('search')).toBeFocused();
  await page.getByTestId('search').blur();

  // 单击卡片：卡片被选中并打开看板。第一次 Esc 取消选择，第二次 Esc 关闭看板
  await card(page, '键盘新建').click();
  await expect(page.getByTestId('board-panel')).toBeVisible();
  await expect(page.locator('.react-flow__node-event.selected')).toHaveCount(1);
  await page.locator('.react-flow__pane').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.react-flow__node-event.selected')).toHaveCount(0);
  await expect(page.getByTestId('board-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-panel')).toHaveCount(0);
});

test('效率细节：归档提示可撤销；搜索可用方向键与回车；活动记录可定位', async ({ page }) => {
  await signUp(page, 'E', 'eff@x.com');
  await page.getByRole('button', { name: '创建' }).click();
  await createAt(page, '论文初稿', 0.25, 0.3);
  await createAt(page, '论文返修', 0.75, 0.75);

  // 归档后点提示里的“撤销”，卡片回到画布
  await card(page, '论文初稿').click({ button: 'right' });
  await page.locator('.context-menu').getByText('归档', { exact: true }).click();
  await expect(card(page, '论文初稿')).toHaveCount(0);
  await page.locator('.toast', { hasText: '已归档' }).getByRole('button', { name: '撤销' }).click();
  await expect(card(page, '论文初稿')).toBeVisible();

  // 搜索：方向键选择第二个结果，回车打开
  await page.getByTestId('search').fill('论文');
  await expect(page.getByRole('option')).toHaveCount(2);
  const second = await page.getByRole('option').nth(1).locator('span').first().innerText();
  await page.getByTestId('search').press('ArrowDown');
  await expect(page.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('search').press('Enter');
  await expect(page.getByTestId('board-panel').getByRole('textbox', { name: '事件包标题' })).toHaveValue(second);
  await page.getByRole('button', { name: '关闭看板' }).click();

  // 活动记录：点击“创建事件包「论文返修」”定位并打开看板
  await page.getByTitle('活动记录').click();
  await page.locator('.activity-row.clickable', { hasText: '论文返修' }).first().click();
  await expect(page.getByTestId('board-panel').getByRole('textbox', { name: '事件包标题' })).toHaveValue('论文返修');
});

test('错误兜底：看板代码加载失败时只影响看板；工作区加载失败时提示刷新而不是白屏', async ({ page, context }) => {
  // 模拟“页面打开期间发布了新版本，旧的按需加载文件已不存在”
  await page.route(/\/src\/board\/BoardPanel\.tsx/, (r) => r.abort());
  await signUp(page, 'R', 'err@x.com');
  await page.getByRole('button', { name: '创建' }).click();
  await createAt(page, '卡片', 0.25, 0.3);
  await card(page, '卡片').click();
  await expect(page.getByTestId('panel-error')).toContainText('网站已更新');
  await expect(page.getByTestId('panel-error').getByRole('button', { name: '刷新页面' })).toBeVisible();
  // 画布不受影响：仍可新建
  await page.getByTestId('panel-error').getByRole('button', { name: '关闭看板' }).click();
  await expect(page.getByTestId('panel-error')).toHaveCount(0);
  await createAt(page, '仍可新建', 0.75, 0.75);

  // 整个工作区代码取不到：显示整页提示
  const p2 = await context.newPage();
  await p2.route(/\/src\/WorkspaceView\.tsx/, (r) => r.abort());
  await p2.goto('/');
  await p2.getByRole('button', { name: '注册', exact: true }).click();
  await p2.fill('input[placeholder="显示名称"]', 'R2');
  await p2.fill('input[type=email]', 'err2@x.com');
  await p2.fill('input[type=password]', 'secret1');
  await p2.getByRole('button', { name: '注册并登录' }).click();
  await p2.getByRole('button', { name: '创建' }).click();
  await expect(p2.getByTestId('crash-screen')).toContainText('Tessnook 已更新');
  await expect(p2.getByRole('button', { name: '重新加载' })).toBeVisible();
});

test('新版本提示：线上入口脚本变化后，回到页面时提示刷新（生产构建）', async ({ page }) => {
  const PROD = 'http://localhost:4175';
  await signUp(page, 'U', 'upd@x.com', PROD);
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.locator('.region')).toBeVisible();
  // 版本未变化：回到前台不提示
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await page.waitForTimeout(500);
  await expect(page.getByTestId('update-notice')).toHaveCount(0);
  // 模拟发布了新版本：首页引用的入口脚本换了哈希
  await page.route(`${PROD}/`, async (route) => {
    const res = await route.fetch();
    const html = (await res.text()).replace(/\/assets\/index-[\w-]+\.js/, '/assets/index-NEWVERSION.js');
    await route.fulfill({ response: res, body: html });
  });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.getByTestId('update-notice')).toContainText('有新版本可用');
  await page.getByRole('button', { name: '稍后' }).click();
  await expect(page.getByTestId('update-notice')).toHaveCount(0);
});

test('看板拖拽：列表内排序、拖入空列表、拖动手柄调整列表顺序、键盘移动列表', async ({ page }) => {
  await signUp(page, 'KB', 'kanban@x.com');
  await page.getByRole('button', { name: '创建' }).click();
  await createAt(page, 'K', 0.25, 0.3);
  await card(page, 'K').click();
  await page.getByRole('button', { name: '宽屏模式' }).click();
  const lists = page.getByTestId('list-col');
  for (const t of ['一', '二', '三']) {
    await lists.nth(0).locator('input.add-task').fill(t);
    await lists.nth(0).locator('input.add-task').press('Enter');
    await expect(page.getByTestId('task-card').filter({ hasText: t })).toBeVisible();
  }
  const state = async () => {
    const d = await db(page);
    return d.lists.sort((x: any, y: any) => x.position - y.position).map((l: any) =>
      `${l.title}[${d.tasks.filter((t: any) => t.list_id === l.id).sort((x: any, y: any) => x.position - y.position).map((t: any) => t.title).join('')}]`).join(' ');
  };
  const dragTo = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(from.x + 8, from.y + 4, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.up();
  };
  const center = async (l: import('@playwright/test').Locator, dx = 0, dy = 0) => {
    const b = (await l.boundingBox())!;
    return { x: b.x + b.width / 2 + dx, y: b.y + b.height / 2 + dy };
  };
  const task = (t: string) => page.getByTestId('task-card').filter({ hasText: t });

  await dragTo(await center(task('三'), -60), await center(task('一'), -60, -12));
  await expect.poll(state).toBe('待办[三一二] 进行中[] 已完成[]');

  await dragTo(await center(task('二'), -60), await center(lists.nth(2).locator('.list-body')));
  await expect.poll(state).toBe('待办[三一] 进行中[] 已完成[二]');

  await dragTo(await center(lists.nth(2).locator('.grip')), await center(lists.nth(0).locator('.grip'), -60, 40));
  await expect.poll(state).toBe('已完成[二] 待办[三一] 进行中[]');

  // 键盘拖动：拿起后拖拽库需要先测量各列位置，按键之间留出与真实操作相当的间隔
  await lists.nth(0).locator('.grip').focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(150);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  await page.keyboard.press('Space');
  await expect.poll(state).toBe('待办[三一] 已完成[二] 进行中[]');
});

test('Esc 清空全部多选（焦点在某张卡片上时也是），不会把其他卡片误带进下一次堆叠', async ({ page }) => {
  await signUp(page, 'S', 'esc@x.com');
  await page.getByRole('button', { name: '创建' }).click();
  await createAt(page, '甲', 0.15, 0.2);
  await createAt(page, '乙', 0.3, 0.4);
  await createAt(page, '丙', 0.15, 0.45);
  await card(page, '甲').click({ modifiers: ['Shift'] });
  await card(page, '乙').click({ modifiers: ['Shift'] });
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  // 拖动多选的卡片（焦点会落在被拖动的卡片上），再按 Esc
  const b = (await card(page, '甲').boundingBox())!;
  await dragBy(page, b.x + 40, b.y + 15, 50, 40);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);
  await card(page, '甲').click({ modifiers: ['Shift'] });
  await card(page, '丙').click({ modifiers: ['Shift'] });
  await page.locator('.selection-bar').getByText('堆叠').click();
  await expect(page.getByTestId('stack-card')).toContainText('2');
  await expect(card(page, '乙')).toBeVisible();
});

test('外观：可手动选择浅色或深色，刷新后保持；跟随系统可恢复', async ({ browser }) => {
  const bg = (page: import('@playwright/test').Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // 系统为浅色时手动选择深色
  const ctx = await browser.newContext({ colorScheme: 'light', viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await signUp(page, 'T', 'theme@x.com');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.locator('.region')).toBeVisible();
  const light = await bg(page);
  await page.getByRole('button', { name: /账户菜单/ }).click();
  await page.getByRole('radio', { name: '深色' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const dark = await bg(page);
  expect(dark).not.toBe(light);
  await page.reload();
  await expect(page.locator('.region')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bg(page)).toBe(dark);
  // 画布控件（缩放按钮）也跟随深色，而不是 React Flow 默认的白底
  expect(await page.locator('.react-flow__controls-button').first().evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgb(254, 254, 254)');
  // 小地图同理
  await page.getByRole('button', { name: /小地图/ }).first().click();
  expect(await page.locator('.react-flow__minimap').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgb(255, 255, 255)');
  await page.getByRole('button', { name: /小地图/ }).first().click();
  // 跟随系统
  await page.getByRole('button', { name: /账户菜单/ }).click();
  await page.getByRole('radio', { name: '跟随系统' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/);
  expect(await bg(page)).toBe(light);
  await ctx.close();

  // 系统为深色时手动选择浅色
  const ctx2 = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 900 } });
  const p2 = await ctx2.newPage();
  await signUp(p2, 'T2', 'theme2@x.com');
  await p2.getByRole('button', { name: '创建' }).click();
  await expect(p2.locator('.region')).toBeVisible();
  expect(await bg(p2)).toBe(dark);
  await p2.getByRole('button', { name: /账户菜单/ }).click();
  await p2.getByRole('radio', { name: '浅色' }).click();
  expect(await bg(p2)).toBe(light);
  // 手动浅色下的无障碍检查
  const { AxeBuilder } = await import('@axe-core/playwright');
  await p2.keyboard.press('Escape');
  const r = await new AxeBuilder({ page: p2 }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ') + ' ' + (n.any?.[0]?.message ?? '').slice(0, 90)).join(' | ')}`)).toEqual([]);
  await ctx2.close();
});

test('手机宽度：不出现横向滚动；画布缩小时新建输入框仍保持可读大小，并能创建事件包', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await signUp(page, '手机', 'phone@x.com');
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.locator('.region')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  // 触屏上不提键盘快捷键
  await expect(page.locator('.only-coarse', { hasText: '双指可缩放' })).toBeVisible();
  await expect(page.locator('.only-fine', { hasText: '查看全部操作' })).toBeHidden();
  await expect(page.getByRole('button', { name: '快捷键与操作说明' })).toBeHidden();
  await page.getByRole('button', { name: /新建事件包/ }).first().click();
  const input = page.locator('.draft input');
  await expect(input).toBeFocused();
  // 未修复时输入框随画布一起缩小到只有几像素高
  expect((await input.boundingBox())!.height).toBeGreaterThanOrEqual(24);
  await input.fill('手机上新建');
  await input.press('Enter');
  await expect(card(page, '手机上新建')).toBeVisible();
  expect((await db(page)).events.map((e: any) => e.title)).toEqual(['手机上新建']);
  // 顶栏右侧按钮靠右对齐；用户菜单里的“外观”不换行
  const right = (await page.locator('.topbar-right').boundingBox())!;
  expect(right.x + right.width).toBeGreaterThan(390 - 16);
  await page.locator('.topbar .avatar').last().click();
  const label = page.locator('.menu-row > span', { hasText: '外观' });
  const lh = await label.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 20);
  expect((await label.boundingBox())!.height).toBeLessThan(lh * 1.5);
  await ctx.close();
});

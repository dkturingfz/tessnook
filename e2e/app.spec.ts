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

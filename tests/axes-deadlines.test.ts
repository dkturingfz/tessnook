import { describe, expect, it } from 'vitest';
import { AXIS_TEMPLATES, axesOf, quadrantName, validateAxisSetting, validateCustomAxes } from '../src/domain/axes';
import { daysBetween, deadlineAlert, describeDue, effectiveDue, escalatePosition } from '../src/domain/deadlines';
import { cardCenter, quadrantOf, REGION_HEADER_H } from '../src/domain/layout';
import type { CustomAxisConfig, EventPkg, Region } from '../src/domain/types';

const custom: CustomAxisConfig = { x: '难度', y: '收益', quadrants: { Q1: '硬骨头', Q2: '金矿', Q3: '鸡肋', Q4: '坑' }, urgency_x: false };
const region = (over: Partial<Region> = {}): Region => ({
  id: 'r', workspace_id: 'w', version: 1, created_at: '', updated_at: '', name: 'R',
  x: 0, y: 0, width: 1200, height: 800 + REGION_HEADER_H, ...over,
});
const ev = (over: Partial<EventPkg> = {}): EventPkg => ({
  id: 'e', workspace_id: 'w', version: 1, created_at: '', updated_at: '', title: 'E', description: '', status: 'active',
  labels: [], color: null, due_date: null, region_id: 'r', quadrant: 'Q2', x: 100, y: 100, stack_id: null,
  archived_at: null, archived_by: null, created_by: null, ...over,
});

describe('轴模板', () => {
  it('缺失或旧数据回退到默认的重要性 × 紧急性', () => {
    expect(axesOf(undefined).id).toBe('eisenhower');
    expect(axesOf({}).id).toBe('eisenhower');
    expect(axesOf({ template: 'custom', axis_config: null }).id).toBe('eisenhower');
  });
  it('默认模板显示编号，其他模板只显示名称', () => {
    expect(quadrantName({}, 'Q1')).toBe('Q1 重要 · 紧急');
    expect(quadrantName({ template: 'value_effort' }, 'Q2')).toBe('速赢');
    expect(quadrantName({ template: 'custom', axis_config: custom }, 'Q4')).toBe('坑');
  });
  it('只有经典四象限默认把横轴当作紧急程度；自定义可选', () => {
    expect(AXIS_TEMPLATES.eisenhower.urgencyX).toBe(true);
    expect(AXIS_TEMPLATES.value_effort.urgencyX).toBe(false);
    expect(axesOf({ template: 'custom', axis_config: { ...custom, urgency_x: true } }).urgencyX).toBe(true);
  });
  it('校验：模板名、空名称、长度上限', () => {
    expect(validateAxisSetting('eisenhower', null)).toBeNull();
    expect(validateAxisSetting('foo', null)).toMatch('未知');
    expect(validateAxisSetting('custom', null)).toMatch('缺少');
    expect(validateCustomAxes({ ...custom, x: ' ' })).toMatch('横轴');
    expect(validateCustomAxes({ ...custom, quadrants: { ...custom.quadrants, Q2: '一二三四五六七八九十一二三四五六七' } })).toMatch('左上');
    expect(validateCustomAxes(custom)).toBeNull();
  });
});

describe('截止日期提醒', () => {
  const today = '2026-03-10';
  it('日期差与时区无关', () => {
    expect(daysBetween('2026-03-10', '2026-03-13')).toBe(3);
    expect(daysBetween('2026-03-10', '2026-03-09')).toBe(-1);
    expect(daysBetween('2026-02-27', '2026-03-01')).toBe(2);
  });
  it('有效截止日期取事件包与未完成任务中最早的', () => {
    const tasks = [{ title: 'a', due_date: '2026-03-12', done: false }, { title: 'b', due_date: '2026-03-11', done: true }];
    expect(effectiveDue({ due_date: '2026-03-20' }, tasks)).toEqual({ date: '2026-03-12', source: 'task', taskTitle: 'a' });
    expect(effectiveDue({ due_date: '2026-03-11' }, tasks)).toEqual({ date: '2026-03-11', source: 'event' });
    expect(effectiveDue({ due_date: null }, [])).toBeNull();
  });
  it('左侧不紧急象限在提前天数内 → 建议移到同一行的紧急象限', () => {
    const r = region();
    expect(deadlineAlert(ev({ due_date: '2026-03-13' }), [], r, today, 3)).toMatchObject({ kind: 'escalate', target: 'Q1', daysLeft: 3 });
    expect(deadlineAlert(ev({ due_date: '2026-03-14' }), [], r, today, 3)).toBeNull();
    expect(deadlineAlert(ev({ quadrant: 'Q3', due_date: '2026-03-10' }), [], r, today, 3)).toMatchObject({ target: 'Q4', daysLeft: 0 });
    expect(deadlineAlert(ev({ quadrant: 'Q1', due_date: '2026-03-11' }), [], r, today, 3)).toBeNull();
  });
  it('横轴不代表紧急程度的模板不建议升级，但逾期仍提醒', () => {
    const r = region({ template: 'value_effort' });
    expect(deadlineAlert(ev({ due_date: '2026-03-11' }), [], r, today, 3)).toBeNull();
    expect(deadlineAlert(ev({ due_date: '2026-03-09' }), [], r, today, 3)).toMatchObject({ kind: 'overdue', daysLeft: -1 });
  });
  it('不在区域中的事件包只提醒逾期；完成或归档后不提醒', () => {
    expect(deadlineAlert(ev({ region_id: null, quadrant: null, due_date: '2026-03-11' }), [], null, today, 3)).toBeNull();
    expect(deadlineAlert(ev({ due_date: '2026-03-01', status: 'completed' }), [], region(), today, 3)).toBeNull();
    expect(deadlineAlert(ev({ due_date: '2026-03-01', archived_at: 'x' }), [], region(), today, 3)).toBeNull();
  });
  it('截止日期变化后“暂不提醒”的键随之变化', () => {
    const a = deadlineAlert(ev({ due_date: '2026-03-11' }), [], region(), today, 3)!;
    const b = deadlineAlert(ev({ due_date: '2026-03-12' }), [], region(), today, 3)!;
    expect(a.key).not.toBe(b.key);
  });
  it('升级位置：同一高度平移到右侧象限的对应位置', () => {
    const r = region();
    for (const [p, from, to] of [[{ x: 100, y: 100 }, 'Q2', 'Q1'], [{ x: 300, y: 600 }, 'Q3', 'Q4']] as const) {
      expect(quadrantOf(r, cardCenter(p))).toBe(from);
      const q = escalatePosition(p, r);
      expect(q.y).toBe(p.y);
      expect(quadrantOf(r, cardCenter(q))).toBe(to);
    }
  });
  it('提醒说明', () => {
    expect(describeDue({ daysLeft: -2, due: { date: '', source: 'event' } })).toBe('已逾期 2 天');
    expect(describeDue({ daysLeft: 1, due: { date: '', source: 'task', taskTitle: '写 PPT' } })).toBe('明天截止（任务「写 PPT」）');
  });
});

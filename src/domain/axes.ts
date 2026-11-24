// 区域的轴模板：Q1–Q4 只表示位置（右上、左上、左下、右下），含义由模板决定。
// 判定象限、整理、堆叠、缩放等逻辑都只依赖位置，与模板无关。
import type { AxisTemplateId, CustomAxisConfig, Quadrant, Region } from './types';

export interface QuadrantInfo {
  label: string;
  hint?: string;
}

export interface Axes {
  id: AxisTemplateId;
  name: string;
  /** 横轴（向右增加）与纵轴（向上增加） */
  x: string;
  y: string;
  quadrants: Record<Quadrant, QuadrantInfo>;
  /** 横轴是否代表紧急程度：决定截止日期临近时是否建议移到右侧象限 */
  urgencyX: boolean;
  /** 是否在界面上显示 Q1–Q4 编号（只有经典四象限使用编号） */
  showCodes: boolean;
}

export const AXIS_TEMPLATES: Record<Exclude<AxisTemplateId, 'custom'>, Axes> = {
  eisenhower: {
    id: 'eisenhower', name: '重要性 × 紧急性', x: '紧急性', y: '重要性', urgencyX: true, showCodes: true,
    quadrants: {
      Q1: { label: '重要 · 紧急', hint: '立即处理' },
      Q2: { label: '重要 · 不紧急', hint: '计划推进' },
      Q3: { label: '不重要 · 不紧急', hint: '有空再做' },
      Q4: { label: '不重要 · 紧急', hint: '尽量委派' },
    },
  },
  value_effort: {
    id: 'value_effort', name: '价值 × 投入', x: '投入', y: '价值', urgencyX: false, showCodes: false,
    quadrants: {
      Q1: { label: '重点项目', hint: '高价值、高投入：规划后推进' },
      Q2: { label: '速赢', hint: '高价值、低投入：优先做' },
      Q3: { label: '顺手做', hint: '低价值、低投入：有空再做' },
      Q4: { label: '避免', hint: '低价值、高投入：尽量不做' },
    },
  },
  impact_confidence: {
    id: 'impact_confidence', name: '影响 × 信心', x: '信心', y: '影响', urgencyX: false, showCodes: false,
    quadrants: {
      Q1: { label: '优先做', hint: '影响大、把握大' },
      Q2: { label: '先验证', hint: '影响大、把握小：先做小实验' },
      Q3: { label: '搁置', hint: '影响小、把握小' },
      Q4: { label: '顺便做', hint: '影响小、把握大' },
    },
  },
};

export const TEMPLATE_ORDER: AxisTemplateId[] = ['eisenhower', 'value_effort', 'impact_confidence', 'custom'];

export const AXIS_NAME_MAX = 12;
export const QUADRANT_NAME_MAX = 16;

/** 取区域实际使用的轴；缺失或无效的配置回退到默认模板 */
export function axesOf(region: Pick<Region, 'template' | 'axis_config'> | null | undefined): Axes {
  const t = region?.template ?? 'eisenhower';
  if (t === 'custom' && region?.axis_config && !validateCustomAxes(region.axis_config)) {
    const c = region.axis_config;
    return {
      id: 'custom', name: '自定义', x: c.x, y: c.y, urgencyX: c.urgency_x, showCodes: false,
      quadrants: { Q1: { label: c.quadrants.Q1 }, Q2: { label: c.quadrants.Q2 }, Q3: { label: c.quadrants.Q3 }, Q4: { label: c.quadrants.Q4 } },
    };
  }
  return t !== 'custom' && t in AXIS_TEMPLATES ? AXIS_TEMPLATES[t] : AXIS_TEMPLATES.eisenhower;
}

/** 象限的显示名称，例如 “Q1 重要 · 紧急” 或 “速赢” */
export function quadrantName(region: Pick<Region, 'template' | 'axis_config'> | null | undefined, q: Quadrant): string {
  const a = axesOf(region);
  return a.showCodes ? `${q} ${a.quadrants[q].label}` : a.quadrants[q].label;
}

/** 校验自定义轴配置；返回 null 表示有效 */
export function validateCustomAxes(c: CustomAxisConfig | null | undefined): string | null {
  if (!c || typeof c !== 'object') return '缺少自定义轴配置';
  const name = (v: unknown, label: string, max: number) => {
    if (typeof v !== 'string' || !v.trim()) return `${label}不能为空`;
    if (v.trim().length > max) return `${label}最多 ${max} 个字`;
    return null;
  };
  return (
    name(c.x, '横轴名称', AXIS_NAME_MAX) ??
    name(c.y, '纵轴名称', AXIS_NAME_MAX) ??
    (['Q2', 'Q1', 'Q3', 'Q4'] as Quadrant[]).map((q) => name(c.quadrants?.[q], `${POSITION_NAME[q]}象限名称`, QUADRANT_NAME_MAX)).find(Boolean) ??
    (typeof c.urgency_x === 'boolean' ? null : '缺少“横轴表示紧急程度”设置')
  );
}

/** 校验整个轴设置（模板 + 配置）；后端实现同样执行这条规则 */
export function validateAxisSetting(template: unknown, config: CustomAxisConfig | null | undefined): string | null {
  if (!TEMPLATE_ORDER.includes(template as AxisTemplateId)) return '未知的轴模板';
  if (template === 'custom') return validateCustomAxes(config);
  return null;
}

export const POSITION_NAME: Record<Quadrant, string> = { Q1: '右上', Q2: '左上', Q3: '左下', Q4: '右下' };

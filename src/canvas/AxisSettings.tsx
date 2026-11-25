import { useEffect, useMemo, useRef, useState } from 'react';
import { useDialogFocus } from '../components/useDialogFocus';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { AxisTemplateId, CustomAxisConfig, Quadrant, Region } from '../domain/types';
import {
  AXIS_NAME_MAX, AXIS_TEMPLATES, POSITION_NAME, QUADRANT_NAME_MAX, TEMPLATE_ORDER, axesOf, validateAxisSetting, type Axes,
} from '../domain/axes';
import { useStore } from '../store/store';

const GRID: Quadrant[] = ['Q2', 'Q1', 'Q3', 'Q4']; // 左上、右上、左下、右下

/** 2×2 预览：位置与画布上的象限一致，颜色取自品牌色 */
function AxesPreview({ axes, compact }: { axes: Axes; compact?: boolean }) {
  return (
    <div className={`axes-preview ${compact ? 'compact' : ''}`}>
      <span className="ap-y">↑ {axes.y}</span>
      <div className="ap-grid">
        {GRID.map((q) => (
          <span key={q} className={`ap-cell ap-${q}`}>{axes.showCodes && !compact ? `${q} ` : ''}{axes.quadrants[q].label}</span>
        ))}
      </div>
      <span className="ap-x">{axes.x} →</span>
    </div>
  );
}

export function AxisSettings({ region, onClose }: { region: Region; onClose(): void }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef);
  const updateRow = useStore((s) => s.updateRow);
  const current = axesOf(region);
  const [template, setTemplate] = useState<AxisTemplateId>(region.template ?? 'eisenhower');
  // 自定义表单默认从当前生效的轴开始，便于在现有模板基础上修改
  const [custom, setCustom] = useState<CustomAxisConfig>(() =>
    region.axis_config ?? {
      x: current.x, y: current.y, urgency_x: current.urgencyX,
      quadrants: { Q1: current.quadrants.Q1.label, Q2: current.quadrants.Q2.label, Q3: current.quadrants.Q3.label, Q4: current.quadrants.Q4.label },
    },
  );

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const config = template === 'custom' ? custom : null;
  const problem = validateAxisSetting(template, config);
  const preview = useMemo(() => axesOf({ template, axis_config: config }), [template, config]);
  const changed = template !== (region.template ?? 'eisenhower') || JSON.stringify(config) !== JSON.stringify(region.axis_config ?? null);

  const save = async () => {
    if (problem || !changed) return onClose();
    const trimmed = config && {
      ...config, x: config.x.trim(), y: config.y.trim(),
      quadrants: Object.fromEntries(Object.entries(config.quadrants).map(([k, v]) => [k, v.trim()])) as Record<Quadrant, string>,
    };
    await updateRow('regions', region.id, { template, axis_config: trimmed });
    onClose();
  };

  const setQ = (q: Quadrant, v: string) => setCustom((c) => ({ ...c, quadrants: { ...c.quadrants, [q]: v } }));

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div ref={dialogRef} tabIndex={-1} className="modal axis-settings" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="区域轴设置">
        <div className="modal-head">
          <h2>轴设置 · {region.name}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </div>

        <div className="template-list" role="radiogroup" aria-label="轴模板">
          {TEMPLATE_ORDER.map((id) => {
            const axes = id === 'custom' ? axesOf({ template: 'custom', axis_config: custom }) : AXIS_TEMPLATES[id];
            return (
              <button key={id} role="radio" aria-checked={template === id} className={`template-card ${template === id ? 'on' : ''}`}
                onClick={() => setTemplate(id)}>
                <span className="template-name">{id === 'custom' ? '自定义' : axes.name}{id === 'eisenhower' && <span className="muted">（默认）</span>}</span>
                <AxesPreview axes={id === 'custom' && validateAxisSetting('custom', custom) ? AXIS_TEMPLATES.eisenhower : axes} compact />
              </button>
            );
          })}
        </div>

        {template === 'custom' && (
          <div className="custom-axes">
            <div className="field-grid two">
              <label>纵轴（向上增加）
                <input aria-label="纵轴名称" value={custom.y} maxLength={AXIS_NAME_MAX} onChange={(e) => setCustom({ ...custom, y: e.target.value })} placeholder="例如：收益" />
              </label>
              <label>横轴（向右增加）
                <input aria-label="横轴名称" value={custom.x} maxLength={AXIS_NAME_MAX} onChange={(e) => setCustom({ ...custom, x: e.target.value })} placeholder="例如：难度" />
              </label>
            </div>
            <div className="quadrant-inputs">
              {GRID.map((q) => (
                <label key={q} className={`qi qi-${q}`}>{POSITION_NAME[q]}
                  <input aria-label={`${POSITION_NAME[q]}象限名称`} value={custom.quadrants[q]} maxLength={QUADRANT_NAME_MAX} onChange={(e) => setQ(q, e.target.value)} />
                </label>
              ))}
            </div>
            <label className="check-line">
              <input type="checkbox" checked={custom.urgency_x} onChange={(e) => setCustom({ ...custom, urgency_x: e.target.checked })} />
              横轴表示紧急程度（截止日期临近时，建议把左侧的事件包移到右侧）
            </label>
          </div>
        )}

        <div className="axis-preview-wrap">
          <div className="section-title">预览</div>
          <AxesPreview axes={problem ? current : preview} />
        </div>

        <p className="muted small">切换后卡片位置不变，象限的含义随之改变。{!preview.urgencyX && '这个模板的横轴不代表紧急程度，因此不会给出“移到紧急象限”的截止日期提醒（逾期提醒仍然有效）。'}</p>
        {problem && <div className="error">{problem}</div>}

        <div className="modal-foot">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={!!problem || !changed} onClick={save}>保存</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

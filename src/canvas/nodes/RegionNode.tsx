import { memo, useState } from 'react';
import { NodeResizer, useReactFlow, type NodeProps, type Node } from '@xyflow/react';
import { GripHorizontal, LayoutGrid, Settings2, Trash2 } from 'lucide-react';
import type { Quadrant } from '../../domain/types';
import { axesOf } from '../../domain/axes';
import { AxisSettings } from '../AxisSettings';
import { REGION_HEADER_H } from '../../domain/layout';
import type { RegionNodeData } from '../adapter';
import { useStore } from '../../store/store';
import { canvasActions } from '../canvasActions';
import { askConfirm } from '../../components/Ask';

const ORDER: Quadrant[] = ['Q2', 'Q1', 'Q3', 'Q4']; // 2×2 网格中的阅读顺序：左上、右上、左下、右下

function RegionNodeImpl({ data }: NodeProps<Node<RegionNodeData, 'region'>>) {
  const { region, highlight, canEdit, counts } = data;
  const updateRow = useStore((s) => s.updateRow);
  const { setNodes } = useReactFlow();
  const deleteRegion = useStore((s) => s.deleteRegion);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(region.name);
  const total = counts.Q1 + counts.Q2 + counts.Q3 + counts.Q4;
  const axes = axesOf(region);
  const [axisOpen, setAxisOpen] = useState(false);

  const commit = () => {
    setEditing(false);
    const v = name.trim();
    if (v && v !== region.name) updateRow('regions', region.id, { name: v });
    else setName(region.name);
  };

  return (
    <div className="region">
      <NodeResizer
        isVisible={canEdit}
        minWidth={400}
        minHeight={300}
        lineClassName="region-resize-line"
        handleClassName="region-resize-handle"
        onResize={(_, p) => {
          // 实时预览：区域内的事件包与卡片堆随区域等比例移动
          const pos = canvasActions.previewResize(region.id, p);
          setNodes((nds) => nds.map((n) => (pos.has(n.id) ? { ...n, position: pos.get(n.id)! } : n)));
        }}
        onResizeEnd={(_, p) => canvasActions.resizeRegion(region.id, p)}
      />
      <div className="region-header" style={{ height: REGION_HEADER_H }}>
        {canEdit && <GripHorizontal size={14} className="region-drag" aria-label="拖动区域" />}
        {editing ? (
          <input
            className="region-name-input nodrag"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') { setName(region.name); setEditing(false); }
            }}
          />
        ) : (
          <span
            className="region-name region-drag"
            title={canEdit ? '双击重命名，拖动移动区域' : undefined}
            // 开始编辑时取当前名称：他人可能已改名，用旧值提交会把名称悄悄改回去
            onDoubleClick={(e) => { e.stopPropagation(); if (canEdit) { setName(region.name); setEditing(true); } }}
          >
            {region.name}
          </span>
        )}
        <span className="region-total region-drag">{total} 个事件包{axes.id !== 'eisenhower' && ` · ${axes.id === 'custom' ? `${axes.y} × ${axes.x}` : axes.name}`}</span>
        <span className="region-drag region-spacer" />
        {canEdit && (
          <>
            <button className="icon-btn nodrag" title="轴设置：选择或自定义坐标轴与象限名称" aria-label="轴设置" onClick={() => setAxisOpen(true)}>
              <Settings2 size={14} />
            </button>
            <button className="icon-btn nodrag" title="整理此区域（按象限网格排列）" onClick={() => canvasActions.arrangeRegion(region.id)}>
              <LayoutGrid size={14} />
            </button>
            <button
              className="icon-btn nodrag"
              title="删除区域（事件包保留在画布上）"
              onClick={async () => {
                if (await askConfirm({ title: '删除区域', message: `删除区域「${region.name}」？区域内的事件包会保留在原位置，但不再属于任何象限。`, confirmLabel: '删除', danger: true })) deleteRegion(region.id);
              }}
            >
              <Trash2 size={14} />
            </button>
          </>
        )}
      </div>
      <div className="region-body">
        {ORDER.map((q) => (
          <div key={q} className={`quadrant quadrant-${q} ${highlight === q ? 'is-target' : ''}`}>
            <div className="quadrant-label" title={axes.quadrants[q].hint}>
              <span className="q-dot" />
              {axes.showCodes && <strong>{q}</strong>}
              <span className={axes.showCodes ? 'q-text' : 'q-text strong'}>{axes.quadrants[q].label}</span>
              {counts[q] > 0 && <span className="q-count">{counts[q]}</span>}
            </div>
          </div>
        ))}
        {/* 坐标轴：沿中心十字线标注方向 */}
        <div className="axis axis-y"><span>↑ {axes.y}</span></div>
        <div className="axis axis-x"><span>{axes.x} →</span></div>
      </div>
      {axisOpen && <AxisSettings region={region} onClose={() => setAxisOpen(false)} />}
    </div>
  );
}

export const RegionNode = memo(RegionNodeImpl);

import { memo, useState } from 'react';
import { NodeResizer, type NodeProps, type Node } from '@xyflow/react';
import { GripHorizontal, LayoutGrid, Trash2 } from 'lucide-react';
import { QUADRANT_META, type Quadrant } from '../../domain/types';
import { REGION_HEADER_H } from '../../domain/layout';
import type { RegionNodeData } from '../adapter';
import { useStore } from '../../store/store';
import { canvasActions } from '../canvasActions';

const ORDER: Quadrant[] = ['Q2', 'Q1', 'Q3', 'Q4']; // 2×2 网格中的阅读顺序：左上、右上、左下、右下

function RegionNodeImpl({ data }: NodeProps<Node<RegionNodeData, 'region'>>) {
  const { region, highlight, canEdit, counts } = data;
  const updateRow = useStore((s) => s.updateRow);
  const deleteRegion = useStore((s) => s.deleteRegion);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(region.name);
  const total = counts.Q1 + counts.Q2 + counts.Q3 + counts.Q4;

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
            onDoubleClick={(e) => { e.stopPropagation(); if (canEdit) setEditing(true); }}
          >
            {region.name}
          </span>
        )}
        <span className="region-total region-drag">{total} 个事件包</span>
        <span className="region-drag region-spacer" />
        {canEdit && (
          <>
            <button className="icon-btn nodrag" title="整理此区域（按象限网格排列）" onClick={() => canvasActions.arrangeRegion(region.id)}>
              <LayoutGrid size={14} />
            </button>
            <button
              className="icon-btn nodrag"
              title="删除区域（事件包保留在画布上）"
              onClick={() => {
                if (confirm(`删除区域「${region.name}」？区域内的事件包会保留在原位置，但不再属于任何象限。`)) deleteRegion(region.id);
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
            <div className="quadrant-label" title={QUADRANT_META[q].hint}>
              <span className="q-dot" />
              <strong>{q}</strong>
              <span className="q-text">{QUADRANT_META[q].label}</span>
              {counts[q] > 0 && <span className="q-count">{counts[q]}</span>}
            </div>
          </div>
        ))}
        {/* 坐标轴：沿中心十字线标注方向 */}
        <div className="axis axis-y"><span>↑ 重要性</span></div>
        <div className="axis axis-x"><span>紧急性 →</span></div>
      </div>
    </div>
  );
}

export const RegionNode = memo(RegionNodeImpl);

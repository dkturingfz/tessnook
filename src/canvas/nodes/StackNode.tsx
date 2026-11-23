import { memo } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import { Layers, Ungroup } from 'lucide-react';
import type { StackNodeData } from '../adapter';
import { EVENT_W } from '../../domain/layout';
import { useStore } from '../../store/store';

function StackNodeImpl({ data, selected }: NodeProps<Node<StackNodeData, 'stack'>>) {
  const { stack, members, expanded, canEdit } = data;
  const openEvent = useStore((s) => s.openEvent);
  const unstack = useStore((s) => s.unstack);
  const top = members[0];

  return (
    <div className={`stack ${selected ? 'is-selected' : ''}`} style={{ width: EVENT_W }} data-testid="stack-card">
      <div className="stack-layer l3" />
      <div className="stack-layer l2" />
      <div className="event-card stack-top" style={{ ['--accent' as any]: top?.color ?? 'var(--accent-default)' }}>
        <div className="event-row">
          <Layers size={16} className="stack-icon" />
          <div className="event-title">{stack.name || top?.title}</div>
          <span className="stack-count">{members.length}</span>
        </div>
        <div className="event-desc">点击展开 · 共 {members.length} 个事件包</div>
      </div>
      {expanded && (
        <div className="stack-popover nodrag nowheel" onClick={(e) => e.stopPropagation()}>
          {members.map((m) => (
            <button key={m.id} className={`stack-item ${m.status === 'completed' ? 'is-done' : ''}`} onClick={() => openEvent(m.id)}>
              <span className="dot" style={{ background: m.color ?? 'var(--accent-default)' }} />
              {m.title}
            </button>
          ))}
          {canEdit && (
            <button className="stack-item unstack" onClick={() => unstack(stack.id)}>
              <Ungroup size={14} /> 解除堆叠
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export const StackNode = memo(StackNodeImpl);

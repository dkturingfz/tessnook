import { memo } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import { CalendarClock, CheckCircle2, Circle, ListChecks } from 'lucide-react';
import type { EventNodeData } from '../adapter';
import { EVENT_W } from '../../domain/layout';
import { useStore, canEdit } from '../../store/store';
import { dueState, formatDue, initials } from '../../components/format';

function EventNodeImpl({ data, selected }: NodeProps<Node<EventNodeData, 'event'>>) {
  const { event: e, progress, viewers, density, isOpen } = data;
  const editable = useStore(canEdit);
  const setStatus = useStore((s) => s.setEventStatus);
  const done = e.status === 'completed';
  const due = dueState(e.due_date, done);

  return (
    <div
      className={`event-card density-${density} ${done ? 'is-done' : ''} ${selected ? 'is-selected' : ''} ${isOpen ? 'is-open' : ''}`}
      style={{ width: EVENT_W, ['--accent' as any]: e.color ?? 'var(--accent-default)' }}
      data-testid="event-card"
    >
      <div className="event-row">
        <button
          className="status-btn nodrag"
          disabled={!editable}
          title={done ? '标记为进行中' : '标记完成'}
          onClick={(ev) => { ev.stopPropagation(); setStatus(e.id, done ? 'active' : 'completed'); }}
        >
          {done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
        </button>
        <div className="event-title">{e.title}</div>
        {viewers.length > 0 && (
          <div className="viewers" title={`${viewers.map((v) => v.display_name).join('、')} 正在查看`}>
            {viewers.slice(0, 3).map((v) => <span key={v.user_id} className="avatar xs">{initials(v.display_name)}</span>)}
          </div>
        )}
      </div>
      {density === 'standard' && (
        <>
          {e.description && <div className="event-desc">{e.description}</div>}
          <div className="event-meta">
            {e.labels.slice(0, 3).map((l) => <span key={l} className="chip">{l}</span>)}
            {e.due_date && (
              <span className={`meta due-${due}`}><CalendarClock size={12} />{formatDue(e.due_date)}</span>
            )}
            {progress.total > 0 && (
              <span className={`meta ${progress.done === progress.total ? 'all-done' : ''}`}>
                <ListChecks size={12} />{progress.done}/{progress.total}
              </span>
            )}
          </div>
          {progress.total > 0 && (
            <div className="progress"><div style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
          )}
        </>
      )}
    </div>
  );
}

export const EventNode = memo(EventNodeImpl);

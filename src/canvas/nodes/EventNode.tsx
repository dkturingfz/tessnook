import { memo } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import { CalendarClock, CheckCircle2, Circle, ListChecks } from 'lucide-react';
import type { EventNodeData } from '../adapter';
import { EVENT_W } from '../../domain/layout';
import { useStore, canEdit } from '../../store/store';
import { dueState, eventAccent, formatDue } from '../../components/format';
import { Avatar } from '../../components/Avatar';

function EventNodeImpl({ data, selected }: NodeProps<Node<EventNodeData, 'event'>>) {
  const { event: e, progress, viewers, density, isOpen } = data;
  const editable = useStore(canEdit);
  const setStatus = useStore((s) => s.setEventStatus);
  const done = e.status === 'completed';
  const due = dueState(e.due_date, done);
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const hasMeta = e.labels.length > 0 || !!e.due_date || progress.total > 0;
  // 卡片宽度有限：有截止日期时只显示一个标签，其余折叠为 +n
  const maxLabels = e.due_date && progress.total > 0 ? 1 : 2;

  return (
    <div
      className={`event-card density-${density} ${done ? 'is-done' : ''} ${selected ? 'is-selected' : ''} ${isOpen ? 'is-open' : ''}`}
      style={{ width: EVENT_W, ['--accent' as any]: eventAccent(e.color, e.quadrant) }}
      data-testid="event-card"
    >
      <div className="event-row">
        <button
          className="status-btn nodrag"
          disabled={!editable}
          title={done ? '标记为进行中' : '标记完成'}
          aria-label={done ? '标记为进行中' : '标记完成'}
          onClick={(ev) => { ev.stopPropagation(); setStatus(e.id, done ? 'active' : 'completed'); }}
        >
          {done ? <CheckCircle2 size={16} /> : <Circle size={16} />}
        </button>
        <div className="event-title" title={e.title}>{e.title}</div>
        {viewers.length > 0 && (
          <div className="viewers" title={`${viewers.map((v) => v.display_name).join('、')} 正在查看`}>
            {viewers.slice(0, 3).map((v) => <Avatar key={v.user_id} id={v.user_id} name={v.display_name} size="xs" />)}
          </div>
        )}
      </div>
      {density === 'standard' && (
        <>
          {e.description ? <div className="event-desc">{e.description}</div> : !hasMeta && <div className="event-empty">点击打开看板</div>}
          {hasMeta && (
            <div className="event-meta">
              {e.labels.slice(0, maxLabels).map((l) => <span key={l} className="chip" title={l}>{l}</span>)}
              {e.labels.length > maxLabels && <span className="chip more" title={e.labels.slice(maxLabels).join('、')}>+{e.labels.length - maxLabels}</span>}
              <span className="meta-spacer" />
              {e.due_date && (
                <span className={`meta due due-${due}`} title={`截止 ${e.due_date}`}><CalendarClock size={12} />{formatDue(e.due_date)}</span>
              )}
              {progress.total > 0 && (
                <span className={`meta ${progress.done === progress.total ? 'all-done' : ''}`} title={`任务完成 ${pct}%`}>
                  <ListChecks size={12} />{progress.done}/{progress.total}
                </span>
              )}
            </div>
          )}
          {progress.total > 0 && <div className="progress edge" aria-hidden><div style={{ width: `${pct}%` }} /></div>}
        </>
      )}
    </div>
  );
}

export const EventNode = memo(EventNodeImpl);

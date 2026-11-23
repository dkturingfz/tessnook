import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, ArchiveRestore, CheckCircle2, ChevronDown, ChevronRight, Circle, Columns2, Maximize2, PanelRight, X,
} from 'lucide-react';
import { QUADRANT_META } from '../domain/types';
import { useStore, canEdit as canEditSel, eventProgress } from '../store/store';
import { EVENT_COLORS, initials, relTime } from '../components/format';
import { Kanban } from './Kanban';

export function BoardPanel() {
  const id = useStore((s) => s.openEventId)!;
  const e = useStore((s) => s.events[id]);
  const regions = useStore((s) => s.regions);
  const presence = useStore((s) => s.presence);
  const me = useStore((s) => s.user);
  const mode = useStore((s) => s.panelMode);
  const width = useStore((s) => s.panelWidth);
  const editable = useStore(canEditSel);
  const tasks = useStore((s) => s.tasks);
  const progress = useMemo(() => eventProgress({ tasks }, id), [tasks, id]);
  const members = useStore((s) => s.members);
  const s = useStore.getState();
  const [title, setTitle] = useState(e?.title ?? '');
  const [desc, setDesc] = useState(e?.description ?? '');
  const [labels, setLabels] = useState(e?.labels.join(', ') ?? '');
  const [showDetails, setShowDetails] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!e) return;
    setTitle(e.title);
    setDesc(e.description);
    setLabels(e.labels.join(', '));
  }, [e?.id, e?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!e) return null;
  const archived = !!e.archived_at;
  const readOnly = !editable || archived;
  const done = e.status === 'completed';
  const viewers = presence.filter((p) => p.open_event_id === id && p.user_id !== me?.id);
  const region = e.region_id ? regions[e.region_id] : null;
  const archivedBy = members.find((m) => m.user_id === e.archived_by);

  // 拖动左边缘调整宽度（标准模式）
  const startResize = (ev: React.PointerEvent) => {
    ev.preventDefault();
    const onMove = (m: PointerEvent) => s.setPanelWidth(1 - m.clientX / window.innerWidth);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const panelWidth = mode === 'focus' ? '100%' : mode === 'wide' ? '70%' : `${width * 100}%`;

  return (
    <aside ref={panelRef} className={`board-panel mode-${mode}`} style={{ width: panelWidth }} data-testid="board-panel">
      {mode !== 'focus' && <div className="resize-handle" onPointerDown={startResize} title="拖动调整宽度" />}
      <header className="board-head" style={{ ['--accent' as any]: e.color ?? 'var(--accent-default)' }}>
        <button className="status-btn" disabled={readOnly} title={done ? '标记为进行中' : '标记完成'}
          onClick={() => s.setEventStatus(e.id, done ? 'active' : 'completed')}>
          {done ? <CheckCircle2 size={20} /> : <Circle size={20} />}
        </button>
        <input className="title-input" value={title} disabled={readOnly} aria-label="事件包标题"
          onChange={(x) => setTitle(x.target.value)}
          onBlur={() => (title.trim() && title !== e.title ? s.updateRow('events', e.id, { title: title.trim() }) : setTitle(e.title))}
          onKeyDown={(x) => x.key === 'Enter' && (x.target as HTMLInputElement).blur()} />
        {viewers.length > 0 && (
          <div className="viewers" title={`${viewers.map((v) => v.display_name).join('、')} 也在查看`}>
            {viewers.map((v) => <span key={v.user_id} className="avatar sm">{initials(v.display_name)}</span>)}
          </div>
        )}
        <div className="mode-switch" role="group" aria-label="显示模式">
          <button className={mode === 'standard' ? 'on' : ''} onClick={() => s.setPanelMode('standard')} title="标准模式"><PanelRight size={15} /></button>
          <button className={mode === 'wide' ? 'on' : ''} onClick={() => s.setPanelMode('wide')} title="宽屏模式"><Columns2 size={15} /></button>
          <button className={mode === 'focus' ? 'on' : ''} onClick={() => s.setPanelMode('focus')} title="专注模式"><Maximize2 size={15} /></button>
        </div>
        <button className="icon-btn" onClick={() => s.openEvent(null)} aria-label="关闭看板"><X size={18} /></button>
      </header>

      {archived && (
        <div className="banner">
          已于 {relTime(e.archived_at!)} 由 {archivedBy?.display_name ?? '成员'} 归档，看板为只读。
          {editable && <button onClick={() => s.restoreEvent(e.id)}><ArchiveRestore size={14} />恢复到画布</button>}
        </div>
      )}

      <div className="board-sub">
        <span className="muted">
          {region ? `${region.name} · ${e.quadrant} ${QUADRANT_META[e.quadrant!].label}` : '未归属四象限区域'}
          {progress.total > 0 && ` · 任务 ${progress.done}/${progress.total}`}
        </span>
        <button className="link" onClick={() => setShowDetails(!showDetails)}>
          {showDetails ? <ChevronDown size={14} /> : <ChevronRight size={14} />}详情
        </button>
        {!readOnly && (
          <span className="board-actions">
            <button onClick={() => s.archiveEvent(e.id, false)}><Archive size={14} />归档</button>
            {!done && <button onClick={() => s.archiveEvent(e.id, true)}><CheckCircle2 size={14} />完成并归档</button>}
          </span>
        )}
      </div>

      {showDetails && (
        <div className="event-details">
          <label className="block">简短描述
            <textarea rows={2} value={desc} disabled={readOnly} placeholder="一句话说明这件事…"
              onChange={(x) => setDesc(x.target.value)}
              onBlur={() => desc !== e.description && s.updateRow('events', e.id, { description: desc })} />
          </label>
          <div className="field-grid">
            <label>标签（逗号分隔）
              <input value={labels} disabled={readOnly} onChange={(x) => setLabels(x.target.value)}
                onBlur={() => {
                  const next = labels.split(/[,，]/).map((v) => v.trim()).filter(Boolean);
                  if (next.join('|') !== e.labels.join('|')) s.updateRow('events', e.id, { labels: next });
                }} />
            </label>
            <label>截止日期
              <input type="date" value={e.due_date ?? ''} disabled={readOnly}
                onChange={(x) => s.updateRow('events', e.id, { due_date: x.target.value || null })} />
            </label>
          </div>
          <div className="colors">
            <span className="muted">颜色</span>
            <button className={`swatch none ${!e.color ? 'on' : ''}`} disabled={readOnly} onClick={() => s.updateRow('events', e.id, { color: null })} aria-label="默认颜色" />
            {EVENT_COLORS.map((c) => (
              <button key={c} className={`swatch ${e.color === c ? 'on' : ''}`} style={{ background: c }} disabled={readOnly}
                onClick={() => s.updateRow('events', e.id, { color: c })} aria-label={c} />
            ))}
          </div>
        </div>
      )}

      <Kanban eventId={e.id} readOnly={readOnly} />
    </aside>
  );
}

import { useEffect, useRef, useState } from 'react';
import { AlarmClock, ArrowRight, Bell, BellOff } from 'lucide-react';
import { LEAD_DAY_OPTIONS, describeDue, type DeadlineAlert } from '../domain/deadlines';
import { quadrantName } from '../domain/axes';
import { useAlerts } from '../store/alerts';
import { useStore, canEdit as canEditSel } from '../store/store';
import { canvasActions } from '../canvas/canvasActions';

/** 顶栏铃铛：整个工作空间的截止日期提醒（已逾期、建议移到紧急象限） */
export function AlertsMenu() {
  const alerts = useAlerts();
  const events = useStore((s) => s.events);
  const regions = useStore((s) => s.regions);
  const leadDays = useStore((s) => s.leadDays);
  const editable = useStore(canEditSel);
  const s = useStore.getState();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 点击菜单外任意位置或按 Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    // 捕获阶段监听：画布会阻止鼠标事件冒泡，冒泡阶段收不到画布上的点击
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const list = [...alerts.values()].sort((a, b) => a.daysLeft - b.daysLeft);
  const overdue = list.filter((a) => a.kind === 'overdue');
  const escalate = list.filter((a) => a.kind === 'escalate');

  const row = (a: DeadlineAlert) => {
    const e = events[a.eventId];
    if (!e) return null;
    const region = e.region_id ? regions[e.region_id] : null;
    return (
      <div key={a.key} className="alert-row" data-testid="alert-row">
        <button className="alert-main" onClick={() => { s.focusEvent(e.id); s.openEvent(e.id); setOpen(false); }} title="定位并打开看板">
          <span className="alert-title">{e.title}</span>
          <span className={`alert-desc ${a.kind}`}>
            {describeDue(a)}
            {a.kind === 'escalate' && region && a.target && ` · 建议移至「${quadrantName(region, a.target)}」`}
          </span>
        </button>
        {a.kind === 'escalate' && editable && (
          e.stack_id
            ? <span className="muted small" title="请先解除堆叠">在卡片堆中</span>
            : <button className="icon-btn" title="移到紧急象限（可撤销）" aria-label="移动" onClick={() => canvasActions.escalate(e.id)}><ArrowRight size={15} /></button>
        )}
        <button className="icon-btn" title="暂不提醒（截止日期变化后会重新提醒）" aria-label="暂不提醒" onClick={() => s.snoozeAlert(a.key)}><BellOff size={15} /></button>
      </div>
    );
  };

  return (
    <div className="menu-anchor" ref={ref}>
      <button className={`icon-btn bell ${list.length ? 'has-alerts' : ''}`} title="截止日期提醒" aria-label={`截止日期提醒（${list.length}）`}
        onClick={() => setOpen(!open)} data-testid="alerts-bell">
        <Bell size={18} />
        {list.length > 0 && <span className={`bell-count ${overdue.length ? 'overdue' : ''}`}>{list.length > 99 ? '99+' : list.length}</span>}
      </button>
      {open && (
        <div className="dropdown right alerts-menu">
          <div className="alerts-head">截止日期提醒</div>
          {list.length === 0 && <div className="menu-note muted">暂无提醒</div>}
          {overdue.length > 0 && <div className="alerts-group"><AlarmClock size={13} />已逾期 · {overdue.length}</div>}
          {overdue.map(row)}
          {escalate.length > 0 && <div className="alerts-group"><ArrowRight size={13} />建议移到紧急象限 · {escalate.length}</div>}
          {escalate.map(row)}
          <div className="alerts-foot">
            <span className="muted small">提前提醒</span>
            <div className="mode-switch" role="group" aria-label="提前提醒天数">
              {LEAD_DAY_OPTIONS.map((d) => (
                <button key={d} className={leadDays === d ? 'on' : ''} onClick={() => s.setLeadDays(d)}>{d} 天</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

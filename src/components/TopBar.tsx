import { useMemo, useRef, useState } from 'react';
import { Archive, ChevronDown, History, LogOut, Plus, Rows3, Search, Users } from 'lucide-react';
import { can, ROLE_LABEL } from '../domain/rules';
import { quadrantName } from '../domain/axes';
import type { Role } from '../domain/types';
import { useStore } from '../store/store';
import { avatarColor, initials } from './format';
import { Avatar } from './Avatar';
import { AlertsMenu } from './AlertsMenu';
import { ExportBackupButton, ImportBackupButton } from './BackupButtons';
import { askText } from './Ask';

export type Dialog = 'archive' | 'members' | 'activity' | null;

export function TopBar({ onDialog }: { onDialog(d: Dialog): void }) {
  const workspace = useStore((s) => s.workspace)!;
  const workspaces = useStore((s) => s.workspaces);
  const user = useStore((s) => s.user)!;
  const role = useStore((s) => s.role);
  const presence = useStore((s) => s.presence);
  const density = useStore((s) => s.density);
  const pending = useStore((s) => s.pendingOps);
  const backend = useStore((s) => s.backend);
  const theme = useStore((s) => s.theme);
  const s = useStore.getState();
  const [wsMenu, setWsMenu] = useState(false);
  const [userMenu, setUserMenu] = useState(false);

  // 同一用户可能开多个标签页，按用户去重；自己的头像已在右上角，不重复显示
  const online = useMemo(() => {
    const m = new Map(presence.filter((p) => p.user_id !== user.id).map((p) => [p.user_id, p]));
    return [...m.values()];
  }, [presence, user.id]);

  return (
    <header className="topbar">
      <div className="menu-anchor">
        <button className="ws-switch" onClick={() => setWsMenu(!wsMenu)} data-testid="ws-switch">
          <img className="logo" src="/logo.svg" alt="" />
          <strong>{workspace.name}</strong>
          <span className="role-tag">{roleName(role)}</span>
          <ChevronDown size={14} />
        </button>
        {wsMenu && (
          <div className="dropdown" onMouseLeave={() => setWsMenu(false)}>
            {workspaces.map((w) => (
              <button key={w.id} className={w.id === workspace.id ? 'on' : ''} onClick={() => { setWsMenu(false); s.openWorkspace(w.id); }}>
                {w.name} <span className="muted">{roleName(w.role)}</span>
              </button>
            ))}
            <hr />
            <button onClick={async () => {
              setWsMenu(false);
              const name = await askText({ title: '新建工作空间', placeholder: '工作空间名称', confirmLabel: '创建' });
              if (name) s.createWorkspace(name);
            }}><Plus size={14} />新建工作空间</button>
            <ImportBackupButton onDone={() => setWsMenu(false)} />
            <ExportBackupButton onDone={() => setWsMenu(false)} />
            {can(role, 'renameWorkspace') && (
              <button onClick={async () => {
                setWsMenu(false);
                const name = await askText({ title: '重命名工作空间', initial: workspace.name, confirmLabel: '保存' });
                if (name && name !== workspace.name) s.renameWorkspace(name);
              }}>重命名当前空间</button>
            )}
            {can(role, 'deleteWorkspace') && (
              <button className="danger" onClick={async () => {
                setWsMenu(false);
                const typed = await askText({
                  title: '删除工作空间',
                  message: `将永久删除「${workspace.name}」及其中的全部数据，所有成员都将无法访问，且无法撤销。\n请输入空间名称确认：`,
                  mustEqual: workspace.name,
                  confirmLabel: '永久删除',
                  danger: true,
                });
                if (typed === workspace.name) s.deleteWorkspace();
              }}>删除工作空间…</button>
            )}
          </div>
        )}
      </div>

      <SearchBox />

      <div className="topbar-right">
        {pending > 0 && <span className="saving">保存中…</span>}
        {online.length > 0 && (
          <div className="online" title={online.map((p) => p.display_name).join('、') + ' 在线'}>
            {online.slice(0, 5).map((p) => <Avatar key={p.user_id} id={p.user_id} name={p.display_name} ring />)}
            {online.length > 5 && <span className="avatar sm more">+{online.length - 5}</span>}
            <span className="online-label">在线</span>
          </div>
        )}
        <AlertsMenu />
        <button className="icon-btn" title={density === 'standard' ? '切换为紧凑卡片' : '切换为标准卡片'}
          onClick={() => s.setDensity(density === 'standard' ? 'compact' : 'standard')}><Rows3 size={18} /></button>
        <button className="icon-btn" title="活动记录" onClick={() => onDialog('activity')}><History size={18} /></button>
        <button className="icon-btn" title="归档中心" onClick={() => onDialog('archive')} data-testid="open-archive"><Archive size={18} /></button>
        <button className="icon-btn" title="成员与邀请" onClick={() => onDialog('members')}><Users size={18} /></button>
        <div className="menu-anchor">
          <button className="avatar md me" style={{ background: avatarColor(user.id) }} onClick={() => setUserMenu(!userMenu)} title={user.email} aria-label={`${initials(user.display_name)} 账户菜单`}>{initials(user.display_name)}</button>
          {userMenu && (
            <div className="dropdown right" onMouseLeave={() => setUserMenu(false)}>
              <div className="menu-note">{user.display_name}<br /><span className="muted">{user.email}</span></div>
              <div className="menu-note muted">
                {backend?.storage === 'browser' ? `${backend.label}：数据仅保存在本浏览器` : `${backend?.label ?? ''}：数据保存在服务端`}
              </div>
              <hr />
              <div className="menu-row">
                <span className="muted small">外观</span>
                <div className="mode-switch" role="radiogroup" aria-label="外观">
                  {([['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']] as const).map(([v, label]) => (
                    <button key={v} role="radio" aria-checked={theme === v} className={theme === v ? 'on' : ''} onClick={() => s.setTheme(v)}>{label}</button>
                  ))}
                </div>
              </div>
              <hr />
              <button onClick={() => s.signOut()}><LogOut size={14} />退出登录</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export function roleName(r: Role | null) {
  return r ? ROLE_LABEL[r] : '';
}

function SearchBox() {
  const events = useStore((s) => s.events);
  const tasks = useStore((s) => s.tasks);
  const regions = useStore((s) => s.regions);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return [];
    const hit = (v: string) => v.toLowerCase().includes(k);
    const evs = Object.values(events)
      .filter((e) => !e.archived_at && (hit(e.title) || hit(e.description) || e.labels.some(hit)))
      .slice(0, 8)
      .map((e) => ({ key: e.id, eventId: e.id, title: e.title, sub: e.quadrant ? `事件包 · ${quadrantName(regions[e.region_id!], e.quadrant)}` : '事件包' }));
    const ts = Object.values(tasks)
      .filter((t) => (hit(t.title) || hit(t.description)) && events[t.event_id] && !events[t.event_id].archived_at)
      .slice(0, 8)
      .map((t) => ({ key: t.id, eventId: t.event_id, title: t.title, sub: `任务 · ${events[t.event_id].title}` }));
    return [...evs, ...ts];
  }, [q, events, tasks, regions]);

  const choose = (r: { eventId: string }) => {
    const s = useStore.getState();
    s.focusEvent(r.eventId);
    s.openEvent(r.eventId);
    setQ('');
    inputRef.current?.blur();
  };

  return (
    <div className="search menu-anchor">
      <Search size={15} />
      <input ref={inputRef} placeholder="搜索事件包与任务" aria-label="搜索事件包与任务" value={q} data-testid="search"
        role="combobox" aria-expanded={open && !!q} aria-controls="search-results"
        aria-activedescendant={open && results[active] ? `search-opt-${active}` : undefined}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') return inputRef.current?.blur();
          if (!results.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % results.length); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + results.length) % results.length); }
          if (e.key === 'Enter') { e.preventDefault(); choose(results[Math.min(active, results.length - 1)]); }
        }} />
      {open && q && (
        <div className="dropdown search-results" id="search-results" role="listbox" aria-label="搜索结果">
          {results.length === 0 && <div className="menu-note muted">没有匹配的活动内容（已归档内容请在归档中心搜索）</div>}
          {results.map((r, i) => (
            <button key={r.key} id={`search-opt-${i}`} role="option" aria-selected={i === active} className={i === active ? 'on' : ''}
              onMouseEnter={() => setActive(i)} onMouseDown={() => choose(r)}>
              <span>{r.title}</span><span className="muted">{r.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

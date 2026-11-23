import { useMemo, useRef, useState } from 'react';
import { Archive, ChevronDown, History, LogOut, Plus, Rows3, Search, Users } from 'lucide-react';
import { repo } from '../data';
import { useStore } from '../store/store';
import { initials } from './format';

export type Dialog = 'archive' | 'members' | 'activity' | null;

export function TopBar({ onDialog }: { onDialog(d: Dialog): void }) {
  const workspace = useStore((s) => s.workspace)!;
  const workspaces = useStore((s) => s.workspaces);
  const user = useStore((s) => s.user)!;
  const role = useStore((s) => s.role);
  const presence = useStore((s) => s.presence);
  const density = useStore((s) => s.density);
  const pending = useStore((s) => s.pendingOps);
  const s = useStore.getState();
  const [wsMenu, setWsMenu] = useState(false);
  const [userMenu, setUserMenu] = useState(false);

  // 同一用户可能开多个标签页，按用户去重
  const online = useMemo(() => {
    const m = new Map(presence.map((p) => [p.user_id, p]));
    return [...m.values()];
  }, [presence]);

  return (
    <header className="topbar">
      <div className="menu-anchor">
        <button className="ws-switch" onClick={() => setWsMenu(!wsMenu)} data-testid="ws-switch">
          <span className="logo">◱</span>
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
            <button onClick={() => {
              setWsMenu(false);
              const name = prompt('新工作空间名称');
              if (name?.trim()) s.createWorkspace(name.trim());
            }}><Plus size={14} />新建工作空间</button>
            {role === 'owner' && (
              <button onClick={async () => {
                setWsMenu(false);
                const name = prompt('重命名工作空间', workspace.name);
                if (name?.trim()) { await repo.renameWorkspace(workspace.id, name.trim()); await s.refreshWorkspaces(); await s.resync(); }
              }}>重命名当前空间</button>
            )}
            {role === 'owner' && (
              <button className="danger" onClick={async () => {
                setWsMenu(false);
                const typed = prompt(`永久删除工作空间及其全部数据。请输入空间名称「${workspace.name}」确认：`);
                if (typed !== workspace.name) return;
                await repo.deleteWorkspace(workspace.id);
                await s.refreshWorkspaces();
                useStore.setState({ workspace: null });
              }}>删除工作空间…</button>
            )}
          </div>
        )}
      </div>

      <SearchBox />

      <div className="topbar-right">
        {pending > 0 && <span className="saving">保存中…</span>}
        <div className="online" title={online.map((p) => p.display_name).join('、') + ' 在线'}>
          {online.slice(0, 5).map((p) => (
            <span key={p.user_id} className={`avatar sm ${p.user_id === user.id ? 'me' : ''}`}>{initials(p.display_name)}</span>
          ))}
          {online.length > 5 && <span className="avatar sm">+{online.length - 5}</span>}
        </div>
        <button className="icon-btn" title={density === 'standard' ? '切换为紧凑卡片' : '切换为标准卡片'}
          onClick={() => s.setDensity(density === 'standard' ? 'compact' : 'standard')}><Rows3 size={18} /></button>
        <button className="icon-btn" title="活动记录" onClick={() => onDialog('activity')}><History size={18} /></button>
        <button className="icon-btn" title="归档中心" onClick={() => onDialog('archive')} data-testid="open-archive"><Archive size={18} /></button>
        <button className="icon-btn" title="成员与邀请" onClick={() => onDialog('members')}><Users size={18} /></button>
        <div className="menu-anchor">
          <button className="avatar me" onClick={() => setUserMenu(!userMenu)} title={user.email}>{initials(user.display_name)}</button>
          {userMenu && (
            <div className="dropdown right" onMouseLeave={() => setUserMenu(false)}>
              <div className="menu-note">{user.display_name}<br /><span className="muted">{user.email}</span></div>
              <div className="menu-note muted">{repo.mode === 'local' ? '本地模式（未连接 Supabase）' : '云端模式'}</div>
              <hr />
              <button onClick={() => s.signOut()}><LogOut size={14} />退出登录</button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export function roleName(r: string | null) {
  return r === 'owner' ? 'Owner' : r === 'editor' ? 'Editor' : r === 'viewer' ? 'Viewer' : '';
}

function SearchBox() {
  const events = useStore((s) => s.events);
  const tasks = useStore((s) => s.tasks);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return [];
    const hit = (v: string) => v.toLowerCase().includes(k);
    const evs = Object.values(events)
      .filter((e) => !e.archived_at && (hit(e.title) || hit(e.description) || e.labels.some(hit)))
      .slice(0, 8)
      .map((e) => ({ key: e.id, eventId: e.id, title: e.title, sub: e.quadrant ? `事件包 · ${e.quadrant}` : '事件包' }));
    const ts = Object.values(tasks)
      .filter((t) => (hit(t.title) || hit(t.description)) && events[t.event_id] && !events[t.event_id].archived_at)
      .slice(0, 8)
      .map((t) => ({ key: t.id, eventId: t.event_id, title: t.title, sub: `任务 · ${events[t.event_id].title}` }));
    return [...evs, ...ts];
  }, [q, events, tasks]);

  return (
    <div className="search menu-anchor">
      <Search size={15} />
      <input ref={inputRef} placeholder="搜索事件包与任务" value={q} data-testid="search"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => e.key === 'Escape' && inputRef.current?.blur()} />
      {open && q && (
        <div className="dropdown search-results">
          {results.length === 0 && <div className="menu-note muted">没有匹配的活动内容（已归档内容请在归档中心搜索）</div>}
          {results.map((r) => (
            <button key={r.key} onMouseDown={() => {
              const s = useStore.getState();
              s.focusEvent(r.eventId);
              s.openEvent(r.eventId);
              setQ('');
            }}>
              <span>{r.title}</span><span className="muted">{r.sub}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

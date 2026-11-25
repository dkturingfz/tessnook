import { useEffect, useMemo, useState } from 'react';
import { ArchiveRestore, Copy, Eye, X } from 'lucide-react';
import type { Activity, Role } from '../domain/types';
import { can } from '../domain/rules';
import { useStore } from '../store/store';
import { relTime } from './format';
import { roleName } from './TopBar';
import { Avatar } from './Avatar';
import { askConfirm } from './Ask';

function Modal({ title, onClose, children, wide }: { title: string; onClose(): void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
        {children}
      </div>
    </div>
  );
}

// —————————————————— 归档中心 ——————————————————
export function ArchiveCenter({ onClose }: { onClose(): void }) {
  const events = useStore((s) => s.events);
  const members = useStore((s) => s.members);
  const role = useStore((s) => s.role);
  const s = useStore.getState();
  const [q, setQ] = useState('');
  const [order, setOrder] = useState<'new' | 'old'>('new');

  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    return Object.values(events)
      .filter((e) => e.archived_at && (!k || e.title.toLowerCase().includes(k) || e.description.toLowerCase().includes(k)))
      .sort((a, b) => (order === 'new' ? -1 : 1) * a.archived_at!.localeCompare(b.archived_at!));
  }, [events, q, order]);

  // 按归档月份分组，便于“按时间查看”
  const groups = useMemo(() => {
    const m = new Map<string, typeof list>();
    for (const e of list) {
      const d = new Date(e.archived_at!);
      const key = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
      m.set(key, [...(m.get(key) ?? []), e]);
    }
    return [...m.entries()];
  }, [list]);

  return (
    <Modal title="归档中心" onClose={onClose} wide>
      <div className="toolbar-row">
        <input placeholder="搜索归档事件标题" aria-label="搜索归档事件标题" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <select aria-label="排序方式" value={order} onChange={(e) => setOrder(e.target.value as any)}>
          <option value="new">最近归档在前</option>
          <option value="old">最早归档在前</option>
        </select>
      </div>
      {list.length === 0 && <p className="muted">暂无归档事件</p>}
      {groups.map(([month, evs]) => (
        <div key={month}>
          <div className="section-title">{month}</div>
          {evs.map((e) => (
            <div key={e.id} className="archive-row" data-testid="archive-row">
              <span className="dot" style={{ background: e.color ?? 'var(--accent-default)' }} />
              <div className="grow">
                <div>{e.title} {e.status === 'completed' && <span className="chip ok">已完成</span>}</div>
                <div className="muted small">
                  {relTime(e.archived_at!)} · {members.find((m) => m.user_id === e.archived_by)?.display_name ?? '成员'} 归档
                </div>
              </div>
              <button onClick={() => { s.openEvent(e.id); onClose(); }}><Eye size={14} />查看看板</button>
              {can(role, 'archive') && <button onClick={() => s.restoreEvent(e.id)}><ArchiveRestore size={14} />恢复</button>}
              {can(role, 'deleteEvent') && (
                <button className="danger" onClick={async () => (await askConfirm({ title: '永久删除事件包', message: `永久删除「${e.title}」及其全部任务？此操作无法撤销。`, confirmLabel: '永久删除', danger: true })) && s.removeRow('events', e.id)}>删除</button>
              )}
            </div>
          ))}
        </div>
      ))}
    </Modal>
  );
}

// —————————————————— 成员与邀请 ——————————————————
export function MembersDialog({ onClose }: { onClose(): void }) {
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.user)!;
  const backend = useStore((s) => s.backend);
  const role = useStore((s) => s.role);
  const presence = useStore((s) => s.presence);
  const s = useStore.getState();
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('editor');
  const [link, setLink] = useState<string | null>(null);
  const isOwner = can(role, 'manageMembers');
  const ownerCount = members.filter((m) => m.role === 'owner').length;
  /** 唯一的 Owner 不能把自己降级或退出（后端同样拒绝），界面上提前说明而不是操作后报错 */
  const soleOwner = (userId: string) => ownerCount <= 1 && members.some((m) => m.user_id === userId && m.role === 'owner');
  const SOLE_OWNER_HINT = '工作空间至少需要一个 Owner：请先把另一位成员设为 Owner';

  return (
    <Modal title="成员与邀请" onClose={onClose}>
      <div className="member-list">
        {members.map((m) => (
          <div key={m.user_id} className="member-row">
            <Avatar id={m.user_id} name={m.display_name} />
            <div className="grow">
              {m.display_name} {m.user_id === me.id && <span className="muted">（你）</span>}
              {presence.some((p) => p.user_id === m.user_id) && <span className="online-dot" title="在线" />}
              <div className="muted small">{m.email}</div>
            </div>
            {isOwner ? (
              <select
                aria-label={`${m.display_name} 的角色`}
                value={m.role}
                disabled={soleOwner(m.user_id)}
                title={soleOwner(m.user_id) ? SOLE_OWNER_HINT : undefined}
                onChange={(e) => s.setMemberRole(m.user_id, e.target.value as Role)}
              >
                <option value="owner">Owner</option>
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
            ) : <span className="role-tag">{roleName(m.role)}</span>}
            {(isOwner && m.user_id !== me.id) && (
              <button className="danger" onClick={async () => (await askConfirm({ title: '移除成员', message: `将 ${m.display_name} 移出该工作空间？对方将无法再访问其中的内容。`, confirmLabel: '移除', danger: true })) && s.removeMember(m.user_id)}>移除</button>
            )}
            {m.user_id === me.id && !soleOwner(me.id) && (
              <button className="danger" onClick={async () => (await askConfirm({ title: '退出工作空间', message: '退出后需要重新被邀请才能再次加入。', confirmLabel: '退出', danger: true })) && s.removeMember(me.id)}>退出</button>
            )}
          </div>
        ))}
      </div>

      {isOwner ? (
        <form className="invite" onSubmit={async (e) => {
          e.preventDefault();
          const token = await s.inviteMember(email.trim() || null, inviteRole);
          if (token) setLink(`${location.origin}${location.pathname}?invite=${token}`);
        }}>
          <div className="section-title">邀请成员</div>
          <div className="toolbar-row">
            <input type="email" aria-label="对方邮箱" placeholder="对方邮箱（留空则任何持链接者可加入）" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select aria-label="邀请的角色" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)}>
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button type="submit" className="primary">生成邀请链接</button>
          </div>
          {link && (
            <div className="invite-link">
              <code>{link}</code>
              <button type="button" onClick={() => { navigator.clipboard?.writeText(link); s.toast('已复制邀请链接', 'success'); }}><Copy size={14} />复制</button>
              <div className="muted small">链接 7 天内有效，仅可使用一次。{backend?.storage === 'browser' && '数据只保存在本浏览器中：请在同一浏览器的新标签页中注册另一个账户后打开此链接。'}</div>
            </div>
          )}
        </form>
      ) : <p className="muted small">只有 Owner 可以邀请成员和调整角色。</p>}
    </Modal>
  );
}

// —————————————————— 活动记录 ——————————————————
export function ActivityDialog({ onClose }: { onClose(): void }) {
  const wsId = useStore((s) => s.workspace?.id);
  const members = useStore((s) => s.members);
  const revision = useStore((s) => s.events);
  const [items, setItems] = useState<Activity[] | null>(null);
  useEffect(() => {
    useStore.getState().listActivity(100).then(setItems).catch(() => setItems([]));
  }, [wsId, revision]);
  // 只有仍在画布上的事件包可以定位（已归档的在归档中心查看）
  const canLocate = (a: Activity) => a.entity_type === 'event' && !!revision[a.entity_id] && !revision[a.entity_id].archived_at;
  const locate = (a: Activity) => {
    const s = useStore.getState();
    s.focusEvent(a.entity_id);
    s.openEvent(a.entity_id);
    onClose();
  };
  return (
    <Modal title="活动记录" onClose={onClose}>
      {!items && <p className="muted">加载中…</p>}
      {items?.length === 0 && <p className="muted">暂无记录</p>}
      <div className="activity">
        {items?.map((a) => (
          <div key={a.id} className={`activity-row ${canLocate(a) ? 'clickable' : ''}`}
            {...(canLocate(a) ? { role: 'button', tabIndex: 0, title: '定位到该事件包', onClick: () => locate(a), onKeyDown: (e: React.KeyboardEvent) => e.key === 'Enter' && locate(a) } : {})}>
            <Avatar id={a.actor_id ?? '?'} name={members.find((m) => m.user_id === a.actor_id)?.display_name ?? '?'} size="xs" />
            <span className="grow">
              <strong>{members.find((m) => m.user_id === a.actor_id)?.display_name ?? '成员'}</strong> {a.summary}
            </span>
            <span className="muted small">{relTime(a.created_at)}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

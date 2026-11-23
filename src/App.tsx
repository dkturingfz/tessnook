import { useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import { repo } from './data';
import { useStore } from './store/store';
import { Canvas } from './canvas/Canvas';
import { BoardPanel } from './board/BoardPanel';
import { TopBar, type Dialog } from './components/TopBar';
import { ActivityDialog, ArchiveCenter, MembersDialog } from './components/Dialogs';
import { AuthPage, WorkspacePicker } from './components/AuthPage';

const INVITE_KEY = 'spatial-board:pending-invite';

export function App() {
  const authChecked = useStore((s) => s.authChecked);
  const user = useStore((s) => s.user);
  const workspace = useStore((s) => s.workspace);
  const workspaces = useStore((s) => s.workspaces);
  const loading = useStore((s) => s.loading);
  const openEventId = useStore((s) => s.openEventId);
  const panelMode = useStore((s) => s.panelMode);
  const [dialog, setDialog] = useState<Dialog>(null);

  useEffect(() => {
    // 邀请链接 ?invite=xxx：先暂存，登录后再接受
    const token = new URLSearchParams(location.search).get('invite');
    if (token) {
      sessionStorage.setItem(INVITE_KEY, token);
      history.replaceState(null, '', location.pathname);
    }
    useStore.getState().init();
  }, []);

  // 登录后：处理待接受邀请，否则自动打开上次的工作空间
  useEffect(() => {
    if (!user || workspace) return;
    const s = useStore.getState();
    const token = sessionStorage.getItem(INVITE_KEY);
    if (token) {
      sessionStorage.removeItem(INVITE_KEY);
      repo.acceptInvitation(token)
        .then(async (wsId) => { await s.refreshWorkspaces(); await s.openWorkspace(wsId); s.toast('已加入工作空间', 'success'); })
        .catch((e) => s.toast(`邀请：${e.message}`, 'error'));
      return;
    }
    let last: string | undefined;
    try { last = JSON.parse(localStorage.getItem('spatial-board:prefs') || '{}').lastWorkspace; } catch { /* ignore */ }
    const target = workspaces.find((w) => w.id === last) ?? (workspaces.length === 1 ? workspaces[0] : undefined);
    if (target) s.openWorkspace(target.id);
  }, [user, workspace, workspaces]);

  if (!authChecked) return <div className="splash">加载中…</div>;
  if (!user) return <><AuthPage /><Toasts /></>;
  if (!workspace) return <>{loading ? <div className="splash">加载中…</div> : <WorkspacePicker />}<Toasts /></>;

  return (
    <ReactFlowProvider>
      <div className="app">
        <TopBar onDialog={setDialog} />
        <main className={`main ${openEventId ? 'panel-open' : ''} panel-${panelMode}`}>
          <Canvas />
          {openEventId && <BoardPanel />}
        </main>
        {dialog === 'archive' && <ArchiveCenter onClose={() => setDialog(null)} />}
        {dialog === 'members' && <MembersDialog onClose={() => setDialog(null)} />}
        {dialog === 'activity' && <ActivityDialog onClose={() => setDialog(null)} />}
        <Toasts />
      </div>
    </ReactFlowProvider>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>{t.text}</div>
      ))}
    </div>
  );
}

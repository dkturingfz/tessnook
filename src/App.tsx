import { lazy, Suspense, useEffect } from 'react';
import { useStore } from './store/store';
import { AuthPage, WorkspacePicker } from './components/AuthPage';
import { Toasts } from './components/Toasts';

// 工作区（画布、看板）按需加载：登录页只下载登录所需的代码
const WorkspaceView = lazy(() => import('./WorkspaceView'));

const INVITE_KEY = 'tessnook:pending-invite';

export function App() {
  const authChecked = useStore((s) => s.authChecked);
  const user = useStore((s) => s.user);
  const workspace = useStore((s) => s.workspace);
  const workspaces = useStore((s) => s.workspaces);
  const loading = useStore((s) => s.loading);

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
      s.acceptInvitation(token);
      return;
    }
    let last: string | undefined;
    try { last = JSON.parse(localStorage.getItem('tessnook:prefs') || '{}').lastWorkspace; } catch { /* ignore */ }
    const target = workspaces.find((w) => w.id === last) ?? (workspaces.length === 1 ? workspaces[0] : undefined);
    if (target) s.openWorkspace(target.id);
  }, [user, workspace, workspaces]);

  if (!authChecked) return <div className="splash">加载中…</div>;
  if (!user) return <><AuthPage /><Toasts /></>;
  if (!workspace) return <>{loading ? <div className="splash">加载中…</div> : <WorkspacePicker />}<Toasts /></>;

  return (
    <Suspense fallback={<div className="splash">加载中…</div>}>
      <WorkspaceView />
    </Suspense>
  );
}

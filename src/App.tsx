import { lazy, Suspense, useEffect, useRef } from 'react';
import { useStore } from './store/store';
import { AuthPage, WorkspacePicker } from './components/AuthPage';
import { Toasts } from './components/Toasts';

// 工作区（画布、看板）按需加载：登录页只下载登录所需的代码
const loadWorkspace = () => import('./WorkspaceView');
const WorkspaceView = lazy(loadWorkspace);

/** 预取工作区代码：已登录时立即开始（与工作空间数据并行）；在登录页时等浏览器空闲（用户输入账号密码期间）。省流量模式下不在登录页预取 */
function prefetchWorkspace(now: boolean) {
  const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  // 预取失败（如网络波动）时忽略：真正进入工作区时会重新加载，并由错误边界处理失败
  const go = () => void loadWorkspace().catch(() => {});
  if (now) return go();
  if (saveData) return;
  const idle = (window as Window & { requestIdleCallback?: (fn: () => void) => void }).requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 1500));
  idle(go);
}

const INVITE_KEY = 'tessnook:pending-invite';

function lastWorkspace(): string | undefined {
  try { return JSON.parse(localStorage.getItem('tessnook:prefs') || '{}').lastWorkspace; } catch { return undefined; }
}

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

  useEffect(() => {
    if (authChecked) prefetchWorkspace(!!user);
  }, [authChecked, user]);

  // 登录后立即打开上次的工作空间，与获取工作空间列表并行（省掉一次往返）；
  // 失败（例如已被移出该空间）不提示，由下面按列表选择的逻辑接手。有待接受的邀请时不抢先打开。
  const userId = user?.id;
  /** 回退逻辑已尝试打开过的空间：打开持续失败时不反复重试（每个用户会话各尝试一次） */
  const fallbackTried = useRef(new Set<string>());
  useEffect(() => {
    fallbackTried.current.clear();
  }, [userId]);
  useEffect(() => {
    if (!userId || sessionStorage.getItem(INVITE_KEY)) return;
    const last = lastWorkspace();
    const s = useStore.getState();
    if (last && !s.workspace && !s.loading) s.openWorkspace(last, { quiet: true });
  }, [userId]);

  // 登录后：处理待接受邀请，否则按工作空间列表打开（上次的空间不可用时的回退）
  useEffect(() => {
    const s = useStore.getState();
    // 读当前值而非渲染时的值：同一轮里上面的“立即打开”可能刚开始加载
    if (!user || workspace || s.loading) return;
    const token = sessionStorage.getItem(INVITE_KEY);
    if (token) {
      sessionStorage.removeItem(INVITE_KEY);
      s.acceptInvitation(token);
      return;
    }
    const last = lastWorkspace();
    const target = workspaces.find((w) => w.id === last) ?? (workspaces.length === 1 ? workspaces[0] : undefined);
    if (target && !fallbackTried.current.has(target.id)) {
      fallbackTried.current.add(target.id);
      s.openWorkspace(target.id);
    }
  }, [user, workspace, workspaces, loading]);

  if (!authChecked) return <div className="splash">加载中…</div>;
  if (!user) return <><AuthPage /><Toasts /></>;
  if (!workspace) return <>{loading ? <div className="splash">加载中…</div> : <WorkspacePicker />}<Toasts /></>;

  return (
    <Suspense fallback={<div className="splash">加载中…</div>}>
      <WorkspaceView />
    </Suspense>
  );
}

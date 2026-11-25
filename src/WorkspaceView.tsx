// 工作区主界面（画布 + 侧边看板 + 弹窗）。由 App 按需加载：登录页不需要下载画布与看板代码。
import { lazy, Suspense, useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore } from './store/store';
import { Canvas } from './canvas/Canvas';
import { TopBar, type Dialog } from './components/TopBar';
import { Toasts } from './components/Toasts';
import { ConnectionBanner } from './components/ConnectionBanner';
import { UpdateNotice } from './components/UpdateNotice';
import { ErrorBoundary, PanelError } from './components/ErrorBoundary';
import { useAlerts } from './store/alerts';
import { DEFAULT_TITLE, pageTitle } from './components/format';

// 看板（含拖拽库）与弹窗再单独拆分；工作区打开后在空闲时预取看板，首次打开不需要等待
const loadBoard = () => import('./board/BoardPanel');
const BoardPanel = lazy(() => loadBoard().then((m) => ({ default: m.BoardPanel })));
const ArchiveCenter = lazy(() => import('./components/Dialogs').then((m) => ({ default: m.ArchiveCenter })));
const MembersDialog = lazy(() => import('./components/Dialogs').then((m) => ({ default: m.MembersDialog })));
const ActivityDialog = lazy(() => import('./components/Dialogs').then((m) => ({ default: m.ActivityDialog })));

export default function WorkspaceView() {
  const openEventId = useStore((s) => s.openEventId);
  const panelMode = useStore((s) => s.panelMode);
  const [dialog, setDialog] = useState<Dialog>(null);

  // 标签页标题随工作空间、打开的事件包与截止提醒数量变化；离开工作区时恢复默认
  const wsName = useStore((s) => s.workspace?.name);
  const eventTitle = useStore((s) => (s.openEventId ? s.events[s.openEventId]?.title : undefined));
  const alertCount = useAlerts().size;
  useEffect(() => {
    document.title = pageTitle({ workspace: wsName, event: eventTitle, alerts: alertCount });
  }, [wsName, eventTitle, alertCount]);
  useEffect(() => () => { document.title = DEFAULT_TITLE; }, []);

  useEffect(() => {
    const idle = (window as any).requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 1500));
    idle(() => { loadBoard(); import('./components/Dialogs'); });
  }, []);

  return (
    <ReactFlowProvider>
      <div className="app">
        <TopBar onDialog={setDialog} />
        <ConnectionBanner />
        <UpdateNotice />
        <main className={`main ${openEventId ? 'panel-open' : ''} panel-${panelMode}`}>
          <Canvas />
          {openEventId && (
            <ErrorBoundary resetKeys={[openEventId]}
              fallback={(error, reset) => <PanelError error={error} onRetry={reset} onClose={() => useStore.getState().openEvent(null)} />}>
              <Suspense fallback={<aside className="board-panel loading" aria-busy="true" />}>
                <BoardPanel />
              </Suspense>
            </ErrorBoundary>
          )}
        </main>
        <ErrorBoundary resetKeys={[dialog]} fallback={(error) => {
          // 弹窗出错：关闭弹窗并提示，不影响其他界面
          setTimeout(() => { setDialog(null); useStore.getState().toast(`窗口无法打开：${error.message}`, 'error'); });
          return null;
        }}>
        <Suspense fallback={null}>
          {dialog === 'archive' && <ArchiveCenter onClose={() => setDialog(null)} />}
          {dialog === 'members' && <MembersDialog onClose={() => setDialog(null)} />}
          {dialog === 'activity' && <ActivityDialog onClose={() => setDialog(null)} />}
        </Suspense>
        </ErrorBoundary>
        <Toasts />
      </div>
    </ReactFlowProvider>
  );
}

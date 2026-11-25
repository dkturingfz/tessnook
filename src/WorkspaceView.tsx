// 工作区主界面（画布 + 侧边看板 + 弹窗）。由 App 按需加载：登录页不需要下载画布与看板代码。
import { lazy, Suspense, useEffect, useState } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore } from './store/store';
import { Canvas } from './canvas/Canvas';
import { TopBar, type Dialog } from './components/TopBar';
import { Toasts } from './components/Toasts';

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

  useEffect(() => {
    const idle = (window as any).requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 1500));
    idle(() => { loadBoard(); import('./components/Dialogs'); });
  }, []);

  return (
    <ReactFlowProvider>
      <div className="app">
        <TopBar onDialog={setDialog} />
        <main className={`main ${openEventId ? 'panel-open' : ''} panel-${panelMode}`}>
          <Canvas />
          {openEventId && (
            <Suspense fallback={<aside className="board-panel loading" aria-busy="true" />}>
              <BoardPanel />
            </Suspense>
          )}
        </main>
        <Suspense fallback={null}>
          {dialog === 'archive' && <ArchiveCenter onClose={() => setDialog(null)} />}
          {dialog === 'members' && <MembersDialog onClose={() => setDialog(null)} />}
          {dialog === 'activity' && <ActivityDialog onClose={() => setDialog(null)} />}
        </Suspense>
        <Toasts />
      </div>
    </ReactFlowProvider>
  );
}

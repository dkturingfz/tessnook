import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw, X } from 'lucide-react';

/** 按需加载的代码文件取不到：通常是页面打开期间网站发布了新版本，旧文件已被替换 */
export function isChunkLoadError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk/i.test(m);
}

interface Props {
  children: ReactNode;
  fallback: (error: Error, reset: () => void) => ReactNode;
  /** 这些值变化时自动清除错误状态（例如切换到另一个事件包） */
  resetKeys?: unknown[];
}

/** 渲染错误兜底：局部出错不再导致整个页面白屏 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[Tessnook] 界面错误', error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    const a = prev.resetKeys ?? [], b = this.props.resetKeys ?? [];
    if (this.state.error && (a.length !== b.length || a.some((v, i) => v !== b[i]))) this.setState({ error: null });
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error, () => this.setState({ error: null })) : this.props.children;
  }
}

/** 整页兜底 */
export function CrashScreen({ error }: { error: Error }) {
  const updated = isChunkLoadError(error);
  return (
    <div className="crash" role="alert" data-testid="crash-screen">
      <AlertTriangle size={28} />
      <h1>{updated ? 'Tessnook 已更新' : '页面出现了问题'}</h1>
      <p className="muted">
        {updated ? '网站刚刚发布了新版本，请刷新页面加载最新版本。你的数据已保存在服务器上。'
          : '已保存的数据不受影响。刷新页面通常可以恢复；如果问题反复出现，请把下面的错误信息告诉管理员。'}
      </p>
      {!updated && <code className="crash-detail">{error.message}</code>}
      <button className="primary" onClick={() => location.reload()}><RefreshCw size={15} />重新加载</button>
    </div>
  );
}

/** 看板区域的局部兜底：画布仍可继续使用 */
export function PanelError({ error, onRetry, onClose }: { error: Error; onRetry(): void; onClose(): void }) {
  const updated = isChunkLoadError(error);
  return (
    <aside className="board-panel panel-error" role="alert" data-testid="panel-error">
      <div className="panel-error-body">
        <AlertTriangle size={24} />
        <strong>{updated ? '看板无法加载：网站已更新' : '看板出现了问题'}</strong>
        <p className="muted">{updated ? '请刷新页面加载最新版本，画布上的内容不受影响。' : '画布仍可正常使用。可以重试，或关闭看板。'}</p>
        {!updated && <code className="crash-detail">{error.message}</code>}
        <div className="toolbar-row">
          {updated
            ? <button className="primary" onClick={() => location.reload()}><RefreshCw size={14} />刷新页面</button>
            : <button className="primary" onClick={onRetry}><RefreshCw size={14} />重试</button>}
          <button onClick={onClose}><X size={14} />关闭看板</button>
        </div>
      </div>
    </aside>
  );
}

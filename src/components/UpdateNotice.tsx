import { useEffect, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';

/** 当前页面加载的入口脚本（生产构建带内容哈希，例如 /assets/index-AbC123.js） */
function currentEntry(): string | null {
  const s = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]');
  return s ? new URL(s.src, location.href).pathname : null;
}

/** 线上最新的入口脚本；取不到时返回 null（离线等情况，静默忽略） */
async function latestEntry(): Promise<string | null> {
  try {
    const html = await (await fetch('/', { cache: 'no-store' })).text();
    return html.match(/\/assets\/index-[\w-]+\.js/)?.[0] ?? null;
  } catch {
    return null;
  }
}

const CHECK_EVERY_MS = 5 * 60_000;

/**
 * 新版本提示：页面回到前台或每 5 分钟检查一次线上版本；入口脚本变化即说明发布了新版本。
 * 只在生产构建中工作（开发模式下没有带哈希的入口脚本）。
 */
export function UpdateNotice() {
  const [available, setAvailable] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const mine = currentEntry();
    if (!mine) return;
    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState !== 'visible') return;
      const latest = await latestEntry();
      if (latest && latest !== mine) setAvailable(true);
    };
    const timer = setInterval(check, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
    };
  }, []);

  if (!available || dismissed) return null;
  return (
    <div className="update-notice" role="status" data-testid="update-notice">
      <span>Tessnook 有新版本可用。</span>
      <button className="link" onClick={() => location.reload()}><RefreshCw size={13} />刷新以更新</button>
      <button className="icon-btn" aria-label="稍后" title="稍后" onClick={() => setDismissed(true)}><X size={14} /></button>
    </div>
  );
}

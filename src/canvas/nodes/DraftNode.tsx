import { useEffect, useRef, useState } from 'react';
import { useStore as useFlowStore, type NodeProps, type Node } from '@xyflow/react';
import type { DraftNodeData } from '../adapter';
import { EVENT_W } from '../../domain/layout';

/** 双击画布后出现的标题输入框：Enter 创建，Esc 取消 */
export function DraftNode({ data }: NodeProps<Node<DraftNodeData, 'draft'>>) {
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // 只结束一次：回车提交后、输入框卸载前，焦点可能被下一次双击移走而触发失焦，
  // 失焦又会提交一次，导致同一个事件包被创建两次。
  const done = useRef(false);
  // 结束后立即隐藏（与清除草稿在同一次渲染中生效）：节点要到下一次渲染才从画布移除，
  // 这几毫秒里它不应再接收输入
  const [finished, setFinished] = useState(false);
  const finish = (submit: boolean) => {
    if (done.current) return;
    done.current = true;
    setFinished(true);
    const t = title.trim();
    if (submit && t) data.onSubmit(t);
    else data.onCancel();
  };
  // 不用 autoFocus：React Flow 在测量完尺寸前会把新节点设为不可见，此时 focus() 会被浏览器忽略
  // （从工具栏按钮新建时尤其明显，焦点会停在按钮上，输入的文字无处可去）。逐帧重试直到聚焦成功。
  useEffect(() => {
    let tries = 0;
    let raf = 0;
    const tick = () => {
      const el = inputRef.current;
      if (!el || document.activeElement === el || tries++ > 30) return;
      el.focus({ preventScroll: true });
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);
  // 视图缩得很小时（例如手机上看整个区域），输入框按反比例放大，保证文字始终可读、可点；
  // 以双击点（卡片顶部往下 20px 的中心）为原点放大，输入框仍出现在点击位置。
  const zoom = useFlowStore((s) => s.transform[2]);
  const k = Math.max(1, 1 / zoom);
  if (finished) return null;
  return (
    <div
      className="event-card draft nodrag"
      style={{ width: EVENT_W, transform: k > 1 ? `scale(${k})` : undefined, transformOrigin: `${EVENT_W / 2}px 20px` }}
    >
      <input
        ref={inputRef}
        placeholder="事件包标题，回车创建"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && title.trim()) finish(true);
          if (e.key === 'Escape') finish(false);
        }}
        onBlur={() => finish(true)}
      />
    </div>
  );
}

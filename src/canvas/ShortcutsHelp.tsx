import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

const KEYS: [string, string][] = [
  ['N', '在视图中央新建事件包'],
  ['/', '搜索事件包与任务'],
  ['F', '适配全部内容'],
  ['Ctrl / ⌘ + Z', '撤销最近一次整理、移动或区域缩放'],
  ['Esc', '关闭菜单 → 取消选择 → 关闭看板'],
  ['?', '打开本说明'],
];

const MOUSE: [string, string][] = [
  ['双击画布', '在该位置创建事件包（落在哪个象限就属于哪个象限）'],
  ['单击事件包', '在右侧打开看板'],
  ['拖动事件包', '移动；拖到另一个象限会改变优先级'],
  ['Shift + 单击', '多选事件包，之后可网格整理、堆叠、完成或归档'],
  ['Shift + 拖动空白处', '框选'],
  ['右键', '事件包、卡片堆或画布的操作菜单'],
  ['拖动区域标题栏', '移动整个四象限区域（区域内的事件包一起移动）'],
  ['拖动区域边角', '缩放区域（区域内的事件包按比例跟随）'],
  ['空白处拖动 / 滚轮', '平移 / 缩放画布'],
];

export function ShortcutsHelp({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === '?') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal shortcuts" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="快捷键与操作说明">
        <div className="modal-head">
          <h2>快捷键与操作说明</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </div>
        <div className="section-title">键盘</div>
        <dl className="shortcut-list">
          {KEYS.map(([k, d]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{d}</dd></div>)}
        </dl>
        <div className="section-title">鼠标</div>
        <dl className="shortcut-list">
          {MOUSE.map(([k, d]) => <div key={k}><dt>{k}</dt><dd>{d}</dd></div>)}
        </dl>
      </div>
    </div>,
    document.body,
  );
}

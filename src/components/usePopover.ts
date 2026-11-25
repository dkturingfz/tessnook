// 下拉菜单的通用关闭行为：按 Esc（焦点回到触发按钮）、点击菜单外任意位置、
// 用 Tab 把焦点移出菜单时关闭。anchorRef 指向同时包含触发按钮与菜单的容器。
import { useEffect, type RefObject } from 'react';

export function usePopover(anchorRef: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const onDown = (e: PointerEvent) => {
      if (anchor && !anchor.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 只处理这个菜单：不连带触发画布的“取消选择 / 关闭看板”
      e.stopImmediatePropagation();
      close();
      anchor?.querySelector<HTMLElement>('[aria-haspopup]')?.focus();
    };
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && anchor && !anchor.contains(next)) close();
    };
    // 捕获阶段：画布会阻止鼠标事件冒泡，冒泡阶段收不到画布上的点击
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    anchor?.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      anchor?.removeEventListener('focusout', onFocusOut);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

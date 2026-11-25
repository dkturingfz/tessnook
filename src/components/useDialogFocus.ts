// 弹窗的键盘焦点管理（WCAG 2.4.3 焦点顺序）：
// - 打开时：若弹窗内还没有焦点（例如没有自动聚焦的输入框），聚焦第一个可聚焦元素；
// - 打开期间：Tab / Shift+Tab 只在弹窗内循环，不会跑到被遮住的页面上；弹窗叠放时只由最上层处理；
// - 关闭时：焦点回到打开前的元素（若它仍在页面上），键盘用户不必从页面开头重新找起。
import { useEffect, type RefObject } from 'react';

const SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 当前打开的弹窗，按打开顺序排列；最后一个是最上层 */
const stack: HTMLElement[] = [];

function focusables(el: HTMLElement): HTMLElement[] {
  return [...el.querySelectorAll<HTMLElement>(SELECTOR)].filter((x) => x.offsetParent !== null || x === document.activeElement);
}

export function useDialogFocus(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = document.activeElement as HTMLElement | null;
    stack.push(el);
    if (!el.contains(document.activeElement)) (focusables(el)[0] ?? el).focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || stack[stack.length - 1] !== el) return;
      const list = focusables(el);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const inside = el.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      const i = stack.lastIndexOf(el);
      if (i >= 0) stack.splice(i, 1);
      if (previous && previous !== document.body && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

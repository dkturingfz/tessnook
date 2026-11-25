// 应用内的确认框与输入框，替代浏览器原生的 confirm() / prompt()：
// 原生弹窗样式无法统一、在手机上体验差、在部分环境（如内嵌网页）中会被直接屏蔽。
// 用法：if (await askConfirm({...})) ...；const name = await askText({...})。
// <AskHost /> 挂在应用根部（main 包中，体积很小），登录页、空间选择页与工作区都可用。
import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

interface ConfirmOpts {
  title: string;
  message?: string;
  confirmLabel?: string;
  /** 危险操作：确认按钮为红色，默认焦点在“取消”上，避免误按回车 */
  danger?: boolean;
}
interface TextOpts extends ConfirmOpts {
  initial?: string;
  placeholder?: string;
  /** 允许提交空字符串（例如清空卡片堆名称） */
  allowEmpty?: boolean;
  /** 必须输入与之完全相同的文字才能确认（用于删除工作空间等不可撤销操作） */
  mustEqual?: string;
}
type Request =
  | { id: number; kind: 'confirm'; opts: ConfirmOpts; resolve(v: boolean): void }
  | { id: number; kind: 'text'; opts: TextOpts; resolve(v: string | null): void };
let seq = 0;

const useAsk = create<{ queue: Request[] }>(() => ({ queue: [] }));

function push(r: Omit<Request, 'id'>) {
  useAsk.setState((s) => ({ queue: [...s.queue, { ...r, id: ++seq } as Request] }));
}
function pop() {
  useAsk.setState((s) => ({ queue: s.queue.slice(1) }));
}

export function askConfirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => push({ kind: 'confirm', opts, resolve } as Omit<Request, 'id'>));
}
export function askText(opts: TextOpts): Promise<string | null> {
  return new Promise((resolve) => push({ kind: 'text', opts, resolve } as Omit<Request, 'id'>));
}

export function AskHost() {
  const req = useAsk((s) => s.queue[0]);
  if (!req) return null;
  return <AskDialog key={req.id} req={req} />;
}

function AskDialog({ req }: { req: Request }) {
  const { opts } = req;
  const t = req.kind === 'text' ? (req.opts as TextOpts) : null;
  const [value, setValue] = useState(t?.initial ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const settled = useRef(false);

  const finish = (ok: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (req.kind === 'confirm') req.resolve(ok);
    else req.resolve(ok ? value.trim() : null);
    pop();
  };

  const valid = !t || (t.mustEqual !== undefined ? value === t.mustEqual : t.allowEmpty || value.trim() !== '');

  useEffect(() => {
    if (t) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else (opts.danger ? cancelRef : okRef).current?.focus();
    // 捕获阶段处理 Esc：只关闭这个确认框，不连带关闭下面的弹窗或触发画布快捷键
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      finish(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="modal-backdrop ask-backdrop" onMouseDown={() => finish(false)}>
      <div
        className="modal ask"
        role={t ? 'dialog' : 'alertdialog'}
        aria-modal="true"
        aria-label={opts.title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head"><h2>{opts.title}</h2></div>
        {opts.message && <p className="ask-message">{opts.message}</p>}
        <form onSubmit={(e) => { e.preventDefault(); if (valid) finish(true); }}>
          {t && (
            <input
              ref={inputRef}
              aria-label={opts.title}
              value={value}
              placeholder={t.placeholder ?? t.mustEqual}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
          <div className="ask-actions">
            <button type="button" ref={cancelRef} onClick={() => finish(false)}>取消</button>
            <button type="submit" ref={okRef} className={opts.danger ? 'danger-solid' : 'primary'} disabled={!valid}>
              {opts.confirmLabel ?? '确定'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

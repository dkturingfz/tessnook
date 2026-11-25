import { useStore } from '../store/store';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const busy = useStore((s) => s.busy);
  return (
    <div className="toasts" aria-live="polite">
      {busy && <div className="toast busy" data-testid="busy">{busy}</div>}
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          <span>{t.text}</span>
          {t.action && (
            <button className="toast-action" onClick={(e) => { e.stopPropagation(); t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>
          )}
        </div>
      ))}
    </div>
  );
}

import { useRef } from 'react';
import { Download, Upload } from 'lucide-react';
import { useStore } from '../store/store';

/** “从备份导入…”：选择 JSON 文件后导入为新的工作空间 */
export function ImportBackupButton({ className, onDone }: { className?: string; onDone?(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const busy = useStore((s) => s.busy);
  return (
    <>
      <button className={className} disabled={!!busy} onClick={() => input.current?.click()}>
        <Upload size={14} />从备份导入…
      </button>
      <input
        ref={input} type="file" accept="application/json,.json" hidden data-testid="import-backup-input"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          onDone?.();
          if (f) await useStore.getState().importBackupFile(f);
        }}
      />
    </>
  );
}

export function ExportBackupButton({ onDone }: { onDone?(): void }) {
  return (
    <button onClick={() => { onDone?.(); useStore.getState().exportBackup(); }} title="下载包含区域、事件包、看板、任务与检查清单的 JSON 文件">
      <Download size={14} />导出备份
    </button>
  );
}

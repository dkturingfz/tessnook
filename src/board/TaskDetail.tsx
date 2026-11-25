import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckSquare, Square, Trash2, X } from 'lucide-react';
import { askConfirm } from '../components/Ask';
import type { ID, Task } from '../domain/types';
import { useStore } from '../store/store';

export function TaskDetail({ taskId, readOnly, onClose }: { taskId: ID; readOnly: boolean; onClose(): void }) {
  const task = useStore((s) => s.tasks[taskId]);
  const lists = useStore((s) => s.lists);
  const members = useStore((s) => s.members);
  const allItems = useStore((s) => s.checklist_items);
  const { updateRow, removeRow, moveTask, addChecklistItem } = useStore.getState();
  const [title, setTitle] = useState(task?.title ?? '');
  const [desc, setDesc] = useState(task?.description ?? '');
  const [labels, setLabels] = useState(task?.labels.join(', ') ?? '');
  const [newItem, setNewItem] = useState('');

  // 其他成员修改后同步到表单（自己正在编辑的字段在失焦时提交）
  useEffect(() => {
    if (!task) return;
    if (document.activeElement?.getAttribute('data-field') !== 'title') setTitle(task.title);
    if (document.activeElement?.getAttribute('data-field') !== 'desc') setDesc(task.description);
    if (document.activeElement?.getAttribute('data-field') !== 'labels') setLabels(task.labels.join(', '));
  }, [task?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items = useMemo(
    () => Object.values(allItems).filter((c) => c.task_id === taskId).sort((a, b) => a.position - b.position),
    [allItems, taskId],
  );

  if (!task) return null; // 被他人删除
  const eventLists = Object.values(lists).filter((l) => l.event_id === task.event_id).sort((a, b) => a.position - b.position);
  const save = (patch: Partial<Task>) => updateRow('tasks', task.id, patch);
  const parsedLabels = (v: string) => v.split(/[,，]/).map((x) => x.trim()).filter(Boolean);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal task-detail" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="任务详情">
        <div className="modal-head">
          <button className="check big" disabled={readOnly} onClick={() => save({ done: !task.done })} aria-label="切换完成">
            {task.done ? <CheckSquare size={20} /> : <Square size={20} />}
          </button>
          <input className="title-input" aria-label="任务标题" data-field="title" value={title} disabled={readOnly}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() && title !== task.title ? save({ title: title.trim() }) : setTitle(task.title)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </div>

        <div className="field-grid">
          <label>所属列表
            <select value={task.list_id} disabled={readOnly} onChange={(e) => {
              const ts = Object.values(useStore.getState().tasks).filter((t) => t.list_id === e.target.value);
              const last = ts.length ? Math.max(...ts.map((t) => t.position)) : 0;
              moveTask(task.id, e.target.value, last + 1024);
            }}>
              {eventLists.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
            </select>
          </label>
          <label>负责人
            <select value={task.assignee_id ?? ''} disabled={readOnly} onChange={(e) => save({ assignee_id: e.target.value || null })}>
              <option value="">未分配</option>
              {members.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}
            </select>
          </label>
          <label>截止日期
            <input type="date" value={task.due_date ?? ''} disabled={readOnly} onChange={(e) => save({ due_date: e.target.value || null })} />
          </label>
          <label>标签（逗号分隔）
            <input data-field="labels" value={labels} disabled={readOnly} onChange={(e) => setLabels(e.target.value)}
              onBlur={() => {
                const next = parsedLabels(labels);
                if (next.join('|') !== task.labels.join('|')) save({ labels: next });
              }} />
          </label>
        </div>

        <label className="block">描述
          <textarea data-field="desc" rows={5} value={desc} disabled={readOnly} placeholder="补充任务细节…"
            onChange={(e) => setDesc(e.target.value)}
            onBlur={() => desc !== task.description && save({ description: desc })} />
        </label>

        <div className="checklist">
          <div className="section-title">
            检查清单 {items.length > 0 && <span className="muted">{items.filter((c) => c.done).length}/{items.length}</span>}
          </div>
          {items.length > 0 && (
            <div className="progress"><div style={{ width: `${(items.filter((c) => c.done).length / items.length) * 100}%` }} /></div>
          )}
          {items.map((c) => (
            <div key={c.id} className={`check-item ${c.done ? 'is-done' : ''}`}>
              <button className="check" disabled={readOnly} onClick={() => updateRow('checklist_items', c.id, { done: !c.done })}>
                {c.done ? <CheckSquare size={15} /> : <Square size={15} />}
              </button>
              <ChecklistText id={c.id} text={c.text} readOnly={readOnly} />
              {!readOnly && <button className="icon-btn" onClick={() => removeRow('checklist_items', c.id)} aria-label="删除"><Trash2 size={13} /></button>}
            </div>
          ))}
          {!readOnly && (
            <form onSubmit={(e) => { e.preventDefault(); if (newItem.trim()) { addChecklistItem(task.id, newItem.trim()); setNewItem(''); } }}>
              <input placeholder="+ 添加检查项" value={newItem} onChange={(e) => setNewItem(e.target.value)} />
            </form>
          )}
        </div>

        {!readOnly && (
          <div className="modal-foot">
            <button className="danger" onClick={async () => { if (await askConfirm({ title: '删除任务', message: `删除任务「${task.title}」及其检查清单？`, confirmLabel: '删除', danger: true })) { removeRow('tasks', task.id); onClose(); } }}>
              <Trash2 size={14} />删除任务
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ChecklistText({ id, text, readOnly }: { id: ID; text: string; readOnly: boolean }) {
  const [v, setV] = useState(text);
  const ref = useRef<HTMLInputElement>(null);
  // 正在编辑这一项时不被他人的修改覆盖（失焦时提交）
  useEffect(() => { if (document.activeElement !== ref.current) setV(text); }, [text]);
  const updateRow = useStore((s) => s.updateRow);
  return (
    <input ref={ref} className="check-text" value={v} disabled={readOnly} onChange={(e) => setV(e.target.value)}
      onBlur={() => v.trim() && v !== text ? updateRow('checklist_items', id, { text: v.trim() }) : setV(text)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
  );
}

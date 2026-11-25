import { useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { CalendarClock, CheckSquare, GripVertical, MoreHorizontal, Square, Trash2 } from 'lucide-react';
import type { BoardList, ID, Task } from '../domain/types';
import { positionBetween } from '../domain/layout';
import { useStore, canEdit } from '../store/store';
import { dueState, formatDue } from '../components/format';
import { TaskDetail } from './TaskDetail';
import { Avatar } from '../components/Avatar';

const L = (id: ID) => `l:${id}`;
const T = (id: ID) => `t:${id}`;
const raw = (dndId: string | number) => String(dndId).slice(2);
const isList = (dndId: string | number) => String(dndId).startsWith('l:');

export function Kanban({ eventId, readOnly }: { eventId: ID; readOnly: boolean }) {
  const allLists = useStore((s) => s.lists);
  const allTasks = useStore((s) => s.tasks);
  const moveTask = useStore((s) => s.moveTask);
  const moveList = useStore((s) => s.moveList);
  const addList = useStore((s) => s.addList);

  const lists = useMemo(
    () => Object.values(allLists).filter((l) => l.event_id === eventId).sort((a, b) => a.position - b.position),
    [allLists, eventId],
  );
  const committed = useMemo(() => {
    const m: Record<ID, ID[]> = {};
    for (const l of lists) m[l.id] = [];
    Object.values(allTasks)
      .filter((t) => t.event_id === eventId && m[t.list_id])
      .sort((a, b) => a.position - b.position)
      .forEach((t) => m[t.list_id].push(t.id));
    return m;
  }, [allTasks, lists, eventId]);

  const [dragItems, setDragItems] = useState<Record<ID, ID[]> | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [openTask, setOpenTask] = useState<ID | null>(null);
  const [newList, setNewList] = useState('');
  const items = dragItems ?? committed;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const containerOf = (dndId: string | number, src = items): ID | undefined => {
    if (isList(dndId)) return raw(dndId);
    const tid = raw(dndId);
    return Object.keys(src).find((lid) => src[lid].includes(tid));
  };

  const onDragStart = (e: DragStartEvent) => {
    setActive(String(e.active.id));
    if (!isList(e.active.id)) setDragItems(structuredClone(committed));
  };

  const onDragOver = ({ active, over }: DragOverEvent) => {
    if (!over || isList(active.id)) return;
    setDragItems((cur) => {
      if (!cur) return cur;
      const from = containerOf(active.id, cur);
      const to = containerOf(over.id, cur);
      if (!from || !to || from === to) return cur;
      const tid = raw(active.id);
      const target = cur[to].filter((x) => x !== tid);
      const overIdx = isList(over.id) ? target.length : target.indexOf(raw(over.id));
      target.splice(overIdx < 0 ? target.length : overIdx, 0, tid);
      return { ...cur, [from]: cur[from].filter((x) => x !== tid), [to]: target };
    });
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setActive(null);
    const finalItems = dragItems;
    setDragItems(null);
    if (!over) return;

    if (isList(active.id)) {
      const ids = lists.map((l) => l.id);
      const from = ids.indexOf(raw(active.id));
      const overList = containerOf(over.id, committed);
      const to = overList ? ids.indexOf(overList) : -1;
      if (from < 0 || to < 0 || from === to) return;
      const next = arrayMove(ids, from, to);
      const i = next.indexOf(raw(active.id));
      moveList(raw(active.id), next[i - 1], next[i + 1]);
      return;
    }

    if (!finalItems) return;
    const tid = raw(active.id);
    const container = containerOf(active.id, finalItems);
    if (!container) return;
    let order = finalItems[container];
    if (!isList(over.id)) {
      const a = order.indexOf(tid);
      const b = order.indexOf(raw(over.id));
      if (a >= 0 && b >= 0 && a !== b) order = arrayMove(order, a, b);
    }
    const i = order.indexOf(tid);
    const pos = (id?: ID) => (id ? allTasks[id]?.position : undefined);
    const task = allTasks[tid];
    // 邻居未变化时不写库
    if (task.list_id === container && committed[container].indexOf(tid) === i) return;
    moveTask(tid, container, positionBetween(pos(order[i - 1]), pos(order[i + 1])));
  };

  const activeTask = active && !isList(active) ? allTasks[raw(active)] : null;
  const activeList = active && isList(active) ? allLists[raw(active)] : null;

  return (
    <div className="kanban">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => { setActive(null); setDragItems(null); }}
      >
        <SortableContext items={lists.map((l) => L(l.id))} strategy={horizontalListSortingStrategy}>
          {lists.map((l) => (
            <ListColumn key={l.id} list={l} taskIds={items[l.id] ?? []} readOnly={readOnly} onOpenTask={setOpenTask} />
          ))}
        </SortableContext>
        <DragOverlay>
          {activeTask && <TaskCard task={activeTask} overlay />}
          {activeList && <div className="list-col overlay"><div className="list-header"><span className="list-title">{activeList.title}</span></div></div>}
        </DragOverlay>
      </DndContext>

      {!readOnly && (
        <form
          className="list-col add-list"
          onSubmit={(e) => { e.preventDefault(); if (newList.trim()) { addList(eventId, newList.trim()); setNewList(''); } }}
        >
          <input placeholder="+ 添加列表" value={newList} onChange={(e) => setNewList(e.target.value)} />
        </form>
      )}
      {lists.length === 0 && readOnly && <div className="muted">该看板还没有列表</div>}
      {openTask && <TaskDetail taskId={openTask} readOnly={readOnly} onClose={() => setOpenTask(null)} />}
    </div>
  );
}

function ListColumn({ list, taskIds, readOnly, onOpenTask }: {
  list: BoardList; taskIds: ID[]; readOnly: boolean; onOpenTask(id: ID): void;
}) {
  const tasks = useStore((s) => s.tasks);
  const updateRow = useStore((s) => s.updateRow);
  const removeRow = useStore((s) => s.removeRow);
  const addTask = useStore((s) => s.addTask);
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: L(list.id), disabled: readOnly });
  const [title, setTitle] = useState<string | null>(null);
  const [newTask, setNewTask] = useState('');
  const [menu, setMenu] = useState(false);

  const commitTitle = () => {
    if (title !== null && title.trim() && title.trim() !== list.title) updateRow('lists', list.id, { title: title.trim() });
    setTitle(null);
  };

  return (
    <div
      ref={setNodeRef}
      className={`list-col ${isDragging ? 'dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid="list-col"
    >
      <div className="list-header">
        {!readOnly && <span className="grip" {...attributes} {...listeners} aria-label="拖动列表"><GripVertical size={14} /></span>}
        {title !== null ? (
          <input autoFocus className="list-title-input" value={title} onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle} onKeyDown={(e) => { if (e.key === 'Enter') commitTitle(); if (e.key === 'Escape') setTitle(null); }} />
        ) : (
          <span className="list-title" onClick={() => !readOnly && setTitle(list.title)}>{list.title}</span>
        )}
        <span className="list-count">{taskIds.length}</span>
        {!readOnly && (
          <div className="menu-anchor">
            <button className="icon-btn" onClick={() => setMenu(!menu)} aria-label="列表操作"><MoreHorizontal size={14} /></button>
            {menu && (
              <div className="dropdown" onMouseLeave={() => setMenu(false)}>
                <button className="danger" onClick={() => {
                  setMenu(false);
                  if (confirm(`删除列表「${list.title}」及其中 ${taskIds.length} 个任务？`)) removeRow('lists', list.id);
                }}><Trash2 size={14} />删除列表</button>
              </div>
            )}
          </div>
        )}
      </div>
      <SortableContext items={taskIds.map(T)} strategy={verticalListSortingStrategy}>
        <div className="list-body">
          {taskIds.map((id) => tasks[id] && <SortableTask key={id} task={tasks[id]} readOnly={readOnly} onOpen={() => onOpenTask(id)} />)}
        </div>
      </SortableContext>
      {!readOnly && (
        <form onSubmit={(e) => { e.preventDefault(); if (newTask.trim()) { addTask(list.id, newTask.trim()); setNewTask(''); } }}>
          <input className="add-task" placeholder="+ 添加任务" value={newTask} onChange={(e) => setNewTask(e.target.value)} />
        </form>
      )}
    </div>
  );
}

function SortableTask({ task, readOnly, onOpen }: { task: Task; readOnly: boolean; onOpen(): void }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: T(task.id), disabled: readOnly });
  // 鼠标：整张卡片可拖动、点击打开；键盘：用拖动手柄排序、用标题按钮打开。
  // 外层不设 role，避免“按钮里嵌套按钮”。
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
      onPointerDown={listeners?.onPointerDown as React.PointerEventHandler | undefined} onClick={onOpen}>
      <TaskCard task={task} onOpen={onOpen}
        dragHandle={readOnly ? undefined : { attributes, onKeyDown: listeners?.onKeyDown as ((e: React.KeyboardEvent) => void) | undefined }} />
    </div>
  );
}

function TaskCard({ task, overlay, onOpen, dragHandle }: {
  task: Task; overlay?: boolean; onOpen?(): void;
  dragHandle?: { attributes: Record<string, any>; onKeyDown?: (e: any) => void };
}) {
  const members = useStore((s) => s.members);
  const checklist = useStore((s) => s.checklist_items);
  const updateRow = useStore((s) => s.updateRow);
  const editable = useStore(canEdit);
  const items = Object.values(checklist).filter((c) => c.task_id === task.id);
  const assignee = members.find((m) => m.user_id === task.assignee_id);
  const due = dueState(task.due_date, task.done);
  return (
    <div className={`task-card ${task.done ? 'is-done' : ''} ${overlay ? 'overlay' : ''}`} data-testid="task-card">
      <div className="task-row">
        <button className="check nodrag" disabled={!editable} aria-label="切换完成"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); updateRow('tasks', task.id, { done: !task.done }); }}>
          {task.done ? <CheckSquare size={15} /> : <Square size={15} />}
        </button>
        {onOpen ? (
          <button className="task-title" onClick={(e) => { e.stopPropagation(); onOpen(); }} title="打开任务详情">{task.title}</button>
        ) : <span className="task-title">{task.title}</span>}
        {dragHandle && (
          <span className="task-grip" {...dragHandle.attributes} onKeyDown={dragHandle.onKeyDown}
            aria-label={`拖动任务「${task.title}」：按空格键拿起，方向键移动，再按空格键放下`}>
            <GripVertical size={13} />
          </span>
        )}
      </div>
      {(task.labels.length > 0 || task.due_date || items.length > 0 || assignee) && (
        <div className="task-meta">
          {task.labels.map((l) => <span key={l} className="chip">{l}</span>)}
          {task.due_date && <span className={`meta due-${due}`}><CalendarClock size={12} />{formatDue(task.due_date)}</span>}
          {items.length > 0 && <span className="meta"><CheckSquare size={12} />{items.filter((c) => c.done).length}/{items.length}</span>}
          {assignee && <Avatar id={assignee.user_id} name={assignee.display_name} size="xs" title={`负责人：${assignee.display_name}`} />}
        </div>
      )}
    </div>
  );
}

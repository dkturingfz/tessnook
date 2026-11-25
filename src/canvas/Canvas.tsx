import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type NodeChange,
  type NodeTypes,
} from '@xyflow/react';
import {
  Archive, CheckCircle2, Grid3x3, Keyboard, Layers, LayoutGrid, Magnet, Map as MapIcon, Plus, RotateCcw, SquareDashed, Undo2, X,
} from 'lucide-react';
import type { ID, ItemMove } from '../domain/types';
import { EVENT_W, cardCenter, locate } from '../domain/layout';
import { useStore, canEdit as canEditSel } from '../store/store';
import { can, validateStack } from '../domain/rules';
import { buildNodes, mergeNodes, type AppNode } from './adapter';
import { quadrantName } from '../domain/axes';
import { RegionNode } from './nodes/RegionNode';
import { EventNode } from './nodes/EventNode';
import { StackNode } from './nodes/StackNode';
import { DraftNode } from './nodes/DraftNode';
import { canvasActions } from './canvasActions';
import { useAlerts } from '../store/alerts';
import { ShortcutsHelp } from './ShortcutsHelp';

/** 键盘移动卡片的方向与步长（与吸附网格一致） */
const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const KEY_STEP = 16;

/** 画布库内置的读屏与控件文字（默认英文），按本应用的实际操作改写为中文 */
const NODE_HELP = '按回车或空格选中；选中后用方向键移动（按住 Shift 移动更多），移到另一个象限会改变优先级；按 Esc 取消选择。';
const ARIA_LABELS = {
  'node.a11yDescription.default': NODE_HELP,
  'node.a11yDescription.keyboardDisabled': NODE_HELP,
  'node.a11yDescription.ariaLiveMessage': ({ direction }: { direction: string; x: number; y: number }) =>
    `已向${({ up: '上', down: '下', left: '左', right: '右' } as Record<string, string>)[direction] ?? ''}移动`,
  'controls.ariaLabel': '画布缩放控制',
  'controls.zoomIn.ariaLabel': '放大',
  'controls.zoomOut.ariaLabel': '缩小',
  'controls.fitView.ariaLabel': '适配全部内容',
  'controls.interactive.ariaLabel': '锁定画布',
  'minimap.ariaLabel': '小地图',
};

const nodeTypes: NodeTypes = { region: RegionNode, event: EventNode, stack: StackNode, draft: DraftNode } as any;

type Menu =
  | { kind: 'event'; id: ID; x: number; y: number }
  | { kind: 'stack'; id: ID; x: number; y: number }
  | { kind: 'pane'; x: number; y: number; flow: { x: number; y: number } };

const VIEW_PREFS = 'tessnook:canvas-prefs';
function loadView() {
  try {
    return { grid: true, snap: false, minimap: false, ...JSON.parse(localStorage.getItem(VIEW_PREFS) || '{}') };
  } catch {
    return { grid: true, snap: false, minimap: false };
  }
}

export function Canvas() {
  const rf = useReactFlow();
  const regions = useStore((s) => s.regions);
  const events = useStore((s) => s.events);
  const stacks = useStore((s) => s.stacks);
  const tasks = useStore((s) => s.tasks);
  const presence = useStore((s) => s.presence);
  const user = useStore((s) => s.user);
  const density = useStore((s) => s.density);
  const openEventId = useStore((s) => s.openEventId);
  const focusRequest = useStore((s) => s.focusRequest);
  const layoutHistory = useStore((s) => s.layoutHistory);
  const workspaceId = useStore((s) => s.workspace?.id);
  const editable = useStore(canEditSel);
  const role = useStore((s) => s.role);
  const actions = useStore.getState();
  const alerts = useAlerts();

  const [nodes, setNodes] = useState<AppNode[]>([]);
  const [hover, setHover] = useState<{ region_id: ID | null; quadrant: any } | null>(null);
  const [draft, setDraftState] = useState<{ x: number; y: number; seq: number } | null>(null);
  // 每个新建输入框都有自己的节点 id，保证是全新挂载的组件（见 DraftNode 的“只结束一次”）
  const draftSeq = useRef(0);
  const setDraft = useCallback((p: { x: number; y: number } | null) => {
    setDraftState(p ? { x: p.x, y: p.y, seq: ++draftSeq.current } : null);
  }, []);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [expandedStack, setExpandedStack] = useState<ID | null>(null);
  const [view, setView] = useState(loadView);
  const [help, setHelp] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<Menu | null>(null);
  menuRef.current = menu;
  const nodesRef = useRef<AppNode[]>([]);
  nodesRef.current = nodes;
  /** 在当前视图中央出现新建输入框（快捷键 N 与工具栏按钮共用） */
  const draftAtCenter = () => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setDraft(rf.screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }));
  };
  const draftAtCenterRef = useRef(draftAtCenter);
  draftAtCenterRef.current = draftAtCenter;
  const busy = useRef(new Set<ID>());
  const dragVersions = useRef(new Map<ID, number>());
  const regionDrag = useRef<{ id: ID; x: number; y: number } | null>(null);

  useEffect(() => {
    try { localStorage.setItem(VIEW_PREFS, JSON.stringify(view)); } catch { /* ignore */ }
  }, [view]);

  // 任务进度一次性统计，避免每张卡片各自扫描全部任务
  const progress = useMemo(() => {
    const m = new Map<ID, { done: number; total: number }>();
    for (const t of Object.values(tasks)) {
      const p = m.get(t.event_id) ?? { done: 0, total: 0 };
      p.total++;
      if (t.done) p.done++;
      m.set(t.event_id, p);
    }
    return m;
  }, [tasks]);

  const submitDraft = useCallback(
    async (title: string) => {
      if (!draft) return;
      const pos = { x: Math.round(draft.x - EVENT_W / 2), y: Math.round(draft.y - 20) };
      setDraft(null);
      const loc = locate(Object.values(useStore.getState().regions), cardCenter(pos));
      await useStore.getState().createEvent(title, pos.x, pos.y, loc.region_id, loc.quadrant);
    },
    [draft],
  );

  const built = useMemo(() => {
    const out = buildNodes({
      regions, events, stacks, progress, presence, myId: user?.id, density,
      canEdit: editable, hover, expandedStack, openEventId, alerts,
    });
    if (draft) {
      out.push({
        id: `__draft__${draft.seq}`, type: 'draft', position: { x: draft.x - EVENT_W / 2, y: draft.y - 20 }, zIndex: 2000,
        draggable: false, selectable: false,
        data: { onSubmit: submitDraft, onCancel: () => setDraft(null) },
      });
    }
    return out;
  }, [regions, events, stacks, progress, presence, user?.id, density, editable, hover, expandedStack, openEventId, draft, submitDraft, alerts]);

  useEffect(() => {
    setNodes((prev) => mergeNodes(prev, built, busy.current));
  }, [built]);

  // 切换工作空间时适配内容
  useEffect(() => {
    const t = setTimeout(() => rf.fitView({ padding: 0.15, duration: 0, maxZoom: 1 }), 50);
    return () => clearTimeout(t);
  }, [workspaceId, rf]);

  // 搜索/恢复后定位到事件包
  useEffect(() => {
    if (!focusRequest) return;
    const s = useStore.getState();
    const e = s.events[focusRequest.id];
    if (!e) return;
    const st = e.stack_id ? s.stacks[e.stack_id] : null;
    const p = st ?? e;
    rf.setCenter(p.x + EVENT_W / 2, p.y + 50, { zoom: Math.max(rf.getZoom(), 0.9), duration: 400 });
    if (st) setExpandedStack(st.id);
  }, [focusRequest, rf]);

  const onNodesChange = useCallback((changes: NodeChange<AppNode>[]) => {
    for (const c of changes) {
      if (c.type === 'dimensions' && c.resizing !== undefined) {
        if (c.resizing) busy.current.add(c.id);
        else setTimeout(() => busy.current.delete(c.id), 300);
      }
    }
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const selected = nodes.filter((n) => n.selected && (n.type === 'event' || n.type === 'stack'));
  const selectedEvents = selected.filter((n) => n.type === 'event').map((n) => n.id);
  // 业务规则来自 domain：界面即时提示，后端仍会再次校验
  const stackProblem = selectedEvents.length > 1 ? validateStack(selectedEvents.map((id) => events[id]).filter(Boolean)) : null;

  // ———————— 拖拽 ————————
  const onNodeDragStart = useCallback((_: unknown, node: AppNode, dragged: AppNode[]) => {
    setMenu(null);
    const s = useStore.getState();
    dragVersions.current.clear();
    for (const n of dragged) {
      busy.current.add(n.id);
      const row = n.type === 'event' ? s.events[n.id] : n.type === 'stack' ? s.stacks[n.id] : s.regions[n.id];
      if (row) dragVersions.current.set(n.id, row.version);
    }
    if (node.type === 'region') regionDrag.current = { id: node.id, x: node.position.x, y: node.position.y };
  }, []);

  const onNodeDrag = useCallback((_: unknown, node: AppNode) => {
    if (node.type === 'region' && regionDrag.current) {
      // 区域内的事件包和卡片堆跟随区域一起移动（本地预览）
      const s = useStore.getState();
      const r = s.regions[node.id];
      const dx = node.position.x - r.x;
      const dy = node.position.y - r.y;
      setNodes((nds) =>
        nds.map((n) => {
          const row = n.type === 'event' ? s.events[n.id] : n.type === 'stack' ? s.stacks[n.id] : null;
          if (!row || row.region_id !== node.id) return n;
          return { ...n, position: { x: row.x + dx, y: row.y + dy } };
        }),
      );
      return;
    }
    if (node.type === 'event' || node.type === 'stack') {
      const loc = locate(Object.values(useStore.getState().regions), cardCenter(node.position));
      setHover((h) => (h?.region_id === loc.region_id && h?.quadrant === loc.quadrant ? h : loc.region_id ? loc : null));
    }
  }, []);

  const onNodeDragStop = useCallback(async (_: unknown, node: AppNode, dragged: AppNode[]) => {
    setHover(null);
    const s = useStore.getState();
    const release = () => setTimeout(() => dragged.forEach((n) => busy.current.delete(n.id)), 50);
    if (node.type === 'region') {
      const r = s.regions[node.id];
      regionDrag.current = null;
      const x = Math.round(node.position.x), y = Math.round(node.position.y);
      if (r && (x !== r.x || y !== r.y)) await s.moveRegion(node.id, x, y, dragVersions.current.get(node.id) ?? r.version);
      release();
      return;
    }
    const regionList = Object.values(s.regions);
    const moves: ItemMove[] = [];
    for (const n of dragged) {
      if (n.type !== 'event' && n.type !== 'stack') continue;
      const row = n.type === 'event' ? s.events[n.id] : s.stacks[n.id];
      if (!row) continue;
      const x = Math.round(n.position.x), y = Math.round(n.position.y);
      if (x === row.x && y === row.y) continue;
      const loc = locate(regionList, cardCenter({ x, y }));
      moves.push({ kind: n.type, id: n.id, x, y, ...loc, version: dragVersions.current.get(n.id) ?? row.version });
    }
    await s.moveItems(moves);
    release();
  }, []);

  // ———————— 点击 / 双击 / 右键 ————————
  const onNodeClick = useCallback((e: React.MouseEvent, node: AppNode) => {
    setMenu(null);
    if (e.shiftKey || e.metaKey || e.ctrlKey) return; // 多选交给 React Flow
    if (node.type === 'event') actions.openEvent(node.id);
    if (node.type === 'stack') setExpandedStack((cur) => (cur === node.id ? null : node.id));
  }, [actions]);

  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!editable) return;
    const target = e.target as HTMLElement;
    if (target.closest('.react-flow__node-event, .react-flow__node-stack, .react-flow__node-draft, .region-header, .react-flow__panel, .react-flow__controls')) return;
    setDraft(rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  }, [editable, rf]);

  const onPaneClick = useCallback(() => {
    setMenu(null);
    setExpandedStack(null);
  }, []);

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: AppNode) => {
    if (node.type !== 'event' && node.type !== 'stack') return;
    e.preventDefault();
    setMenu({ kind: node.type, id: node.id, x: e.clientX, y: e.clientY });
  }, []);

  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent) => {
    e.preventDefault();
    setMenu({ kind: 'pane', x: e.clientX, y: e.clientY, flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
  }, [rf]);

  // Ctrl/Cmd+Z 撤销最近一次整理/移动/区域缩放（输入框中不拦截）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable) return;
      if (document.querySelector('.modal-backdrop')) return; // 弹窗打开时不响应画布快捷键
      const s = useStore.getState();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        s.undoLayout();
        return;
      }
      if (e.key === 'Escape') {
        // 由近及远：菜单 → 选择 → 看板
        if (menuRef.current) return setMenu(null);
        if (nodesRef.current.some((n) => n.selected)) {
          // 取消全部选择。焦点所在的节点交给画布库处理（它会取消该节点并移开焦点）；
          // 若这里也取消它，画布库会判定其“未选中”而重新选中。其余选中的节点由这里取消。
          const focused = t.closest('.react-flow__node')?.getAttribute('data-id') ?? null;
          setNodes((nds) => nds.map((n) => (n.selected && n.id !== focused ? { ...n, selected: false } : n)));
          return;
        }
        if (s.openEventId) s.openEvent(null);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (ARROWS[e.key] && (t === document.body || t.closest('.react-flow'))) {
        // 键盘移动卡片：选中的卡片（没有选中时取焦点所在的卡片）每次移动一格，Shift 五格。
        // 与拖动结束使用同样的保存逻辑：重新判定所在区域与象限。
        const focused = t.closest('.react-flow__node')?.getAttribute('data-id');
        const targets = nodesRef.current.filter((n) => (n.type === 'event' || n.type === 'stack') && (n.selected || n.id === focused));
        if (!targets.length) return;
        e.preventDefault();
        e.stopPropagation();
        if (!canEditSel(s)) return;
        const [dx, dy] = ARROWS[e.key].map((v) => v * KEY_STEP * (e.shiftKey ? 5 : 1));
        const regionList = Object.values(s.regions);
        const moves: ItemMove[] = [];
        let crossed: string | null = null;
        for (const n of targets) {
          const row = n.type === 'event' ? s.events[n.id] : s.stacks[n.id];
          if (!row || (n.type === 'event' && (row as { stack_id?: ID | null }).stack_id)) continue;
          const x = row.x + dx, y = row.y + dy;
          const loc = locate(regionList, cardCenter({ x, y }));
          if (loc.region_id !== row.region_id || loc.quadrant !== row.quadrant) {
            const r = loc.region_id ? s.regions[loc.region_id] : null;
            crossed = r && loc.quadrant ? `已移至「${quadrantName(r, loc.quadrant)}」` : '已移出区域';
          }
          moves.push({ kind: n.type as 'event' | 'stack', id: n.id, x, y, ...loc, version: row.version });
        }
        void s.moveItems(moves).then(() => { if (crossed) useStore.getState().toast(crossed); });
        return;
      }
      if (e.key === '?') { e.preventDefault(); setHelp(true); return; }
      if (e.key === '/') { e.preventDefault(); document.querySelector<HTMLInputElement>('[data-testid=search]')?.focus(); return; }
      const k = e.key.toLowerCase();
      if (k === 'f') { rf.fitView({ padding: 0.15, duration: 300, maxZoom: 1 }); return; }
      if (k === 'n' && canEditSel(s)) {
        e.preventDefault();
        draftAtCenterRef.current();
      }
    };
    // 捕获阶段：先于画布库对已聚焦节点的 Esc 处理读取选中状态，保证“先取消选择、再关闭看板”
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const activeCount = useMemo(() => Object.values(events).filter((e) => !e.archived_at).length, [events]);
  const clearSelection = () => setNodes((nds) => nds.map((n) => (n.selected ? { ...n, selected: false } : n)));
  const refs = selected.map((n) => ({ kind: n.type as 'event' | 'stack', id: n.id }));

  return (
    <div className="canvas" ref={wrapRef} onDoubleClick={onDoubleClick} onContextMenu={(e) => e.preventDefault()}>
      <ReactFlow<AppNode>
        nodes={nodes}
        edges={[]}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        zoomOnDoubleClick={false}
        selectionKeyCode="Shift"
        multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        snapToGrid={view.snap}
        snapGrid={[16, 16]}
        minZoom={0.1}
        maxZoom={2.5}
        nodeDragThreshold={4}
        // 不要开启 onlyRenderVisibleElements：其他成员恢复的事件包重新出现时，可能因尚未测量尺寸而一直不被渲染
        // （端到端协作测试约一半失败）。性能主要靠节点复用与绘制隔离，见 adapter.mergeNodes 与 styles.css。
        elevateNodesOnSelect={false}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        ariaLabelConfig={ARIA_LABELS}
      >
        {view.grid && <Background variant={BackgroundVariant.Lines} gap={32} color="var(--grid)" />}
        <Controls showInteractive={false} position="bottom-left" />
        {view.minimap && <MiniMap pannable zoomable position="bottom-right" nodeColor={(n) => (n.type === 'region' ? 'var(--region-mini)' : 'var(--primary)')} maskColor="var(--minimap-mask)" />}
      </ReactFlow>

      <div className="canvas-toolbar">
        {editable && (
          <button className="primary-action" title="在视图中央新建事件包（N）" onClick={draftAtCenter}><Plus size={16} />新建事件包</button>
        )}
        {editable && (
          <button title="在视图中心新建四象限区域" onClick={() => {
            const c = rf.screenToFlowPosition({ x: window.innerWidth / 3, y: window.innerHeight / 3 });
            actions.createRegion(Math.round(c.x), Math.round(c.y));
          }}><SquareDashed size={16} />新建区域</button>
        )}
        <button title="适配全部内容" onClick={() => rf.fitView({ padding: 0.15, duration: 300, maxZoom: 1 })}><LayoutGrid size={16} />适配内容</button>
        <button title="重置视角" onClick={() => rf.setViewport({ x: 40, y: 80, zoom: 1 }, { duration: 300 })}><RotateCcw size={16} />重置</button>
        <span className="sep" />
        <button className={view.grid ? 'on' : ''} title="显示背景网格" onClick={() => setView((v: any) => ({ ...v, grid: !v.grid }))}><Grid3x3 size={16} /></button>
        <button className={view.snap ? 'on' : ''} title="拖拽时吸附排列网格" onClick={() => setView((v: any) => ({ ...v, snap: !v.snap }))}><Magnet size={16} /></button>
        <button className={view.minimap ? 'on' : ''} title="小地图" aria-label="小地图" onClick={() => setView((v: any) => ({ ...v, minimap: !v.minimap }))}><MapIcon size={16} /></button>
        <button className="only-fine" title="快捷键与操作说明（?）" aria-label="快捷键与操作说明" onClick={() => setHelp(true)}><Keyboard size={16} /></button>
        {editable && layoutHistory.length > 0 && (
          <button title={`撤销「${layoutHistory[layoutHistory.length - 1].label}」(Ctrl+Z)`} aria-label={`撤销${layoutHistory[layoutHistory.length - 1].label}`} onClick={() => actions.undoLayout()}><Undo2 size={16} />撤销</button>
        )}
      </div>

      {selected.length > 1 && (
        <div className="selection-bar" role="toolbar">
          <span>已选 {selected.length} 项</span>
          {editable && (
            <>
              <button onClick={() => canvasActions.arrangeSelection(refs)}><LayoutGrid size={14} />网格整理</button>
              {selectedEvents.length > 1 && selectedEvents.length === selected.length && (
                <button title={stackProblem ?? '把选中的事件包叠成一个卡片堆'} className={stackProblem ? 'blocked' : ''}
                  onClick={async () => {
                    if (stackProblem) return actions.toast(stackProblem, 'error');
                    await actions.createStack(selectedEvents);
                    clearSelection();
                  }}><Layers size={14} />堆叠</button>
              )}
              {selectedEvents.length > 0 && (
                <>
                  <button onClick={() => selectedEvents.forEach((id) => actions.setEventStatus(id, 'completed'))}><CheckCircle2 size={14} />完成</button>
                  <button onClick={async () => { for (const id of selectedEvents) await actions.archiveEvent(id, false); clearSelection(); }}><Archive size={14} />归档</button>
                </>
              )}
            </>
          )}
          <button className="ghost" onClick={clearSelection}><X size={14} /></button>
        </div>
      )}

      {!can(role, 'edit') && <div className="readonly-badge">只读模式（Viewer）</div>}

      {Object.keys(regions).length === 0 && activeCount === 0 && editable && (
        <div className="empty-hint">
          <p>画布是空的。双击任意位置创建事件包，或</p>
          <button onClick={() => actions.createRegion(0, 0)}><Plus size={14} />创建一个四象限区域</button>
        </div>
      )}
      {Object.keys(regions).length > 0 && activeCount === 0 && editable && (
        <div className="start-hint" data-testid="start-hint">
          <strong>开始使用：</strong>双击画布任意位置创建事件包，放在哪个象限就代表它的优先级。
          <span className="muted only-fine">也可以点左上角「新建事件包」或按 <kbd>N</kbd> 在中央新建，按 <kbd>?</kbd> 查看全部操作。</span>
          <span className="muted only-coarse">也可以点左上角的 <Plus size={12} aria-label="新建事件包" /> 在中央新建；双指可缩放画布。</span>
        </div>
      )}
      {help && <ShortcutsHelp onClose={() => setHelp(false)} />}

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} onCreateAt={(p) => { setDraft(p); setMenu(null); }} />}
    </div>
  );
}

function ContextMenu({ menu, onClose, onCreateAt }: { menu: Menu; onClose(): void; onCreateAt(p: { x: number; y: number }): void }) {
  const s = useStore();
  const editable = canEditSel(s);
  const item = (label: string, fn: () => void, danger = false) => (
    <button className={danger ? 'danger' : ''} onClick={() => { fn(); onClose(); }}>{label}</button>
  );
  let body: React.ReactNode = null;

  if (menu.kind === 'event') {
    const e = s.events[menu.id];
    if (!e) return null;
    const done = e.status === 'completed';
    body = (
      <>
        {item('打开看板', () => s.openEvent(e.id))}
        {editable && item(done ? '重新打开' : '标记完成', () => s.setEventStatus(e.id, done ? 'active' : 'completed'))}
        {editable && item('归档', () => s.archiveEvent(e.id, false))}
        {editable && !done && item('完成并归档', () => s.archiveEvent(e.id, true))}
        {can(s.role, 'deleteEvent') && item('永久删除…', () => {
          if (confirm(`永久删除「${e.title}」及其全部任务？此操作无法撤销。`)) s.removeRow('events', e.id);
        }, true)}
      </>
    );
  } else if (menu.kind === 'stack') {
    const st = s.stacks[menu.id];
    if (!st) return null;
    body = (
      <>
        {editable && item('重命名卡片堆', () => {
          const name = prompt('卡片堆名称', st.name ?? '');
          if (name !== null) s.updateRow('stacks', st.id, { name: name.trim() || null });
        })}
        {editable && item('解除堆叠', () => s.unstack(st.id))}
      </>
    );
  } else {
    const loc = locate(Object.values(s.regions), menu.flow);
    body = (
      <>
        {editable && item('在此新建事件包', () => onCreateAt(menu.flow))}
        {editable && item('在此新建四象限区域', () => s.createRegion(Math.round(menu.flow.x), Math.round(menu.flow.y)))}
        {editable && loc.region_id && item('整理此区域', () => canvasActions.arrangeRegion(loc.region_id!))}
        {!editable && <div className="menu-note">只读模式</div>}
      </>
    );
  }
  return (
    <div className="context-menu" style={{ left: menu.x, top: menu.y }} onMouseLeave={onClose}>
      {body}
    </div>
  );
}

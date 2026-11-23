import { useState } from 'react';
import type { NodeProps, Node } from '@xyflow/react';
import type { DraftNodeData } from '../adapter';
import { EVENT_W } from '../../domain/layout';

/** 双击画布后出现的标题输入框：Enter 创建，Esc 取消 */
export function DraftNode({ data }: NodeProps<Node<DraftNodeData, 'draft'>>) {
  const [title, setTitle] = useState('');
  return (
    <div className="event-card draft nodrag" style={{ width: EVENT_W }}>
      <input
        autoFocus
        placeholder="事件包标题，回车创建"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && title.trim()) data.onSubmit(title.trim());
          if (e.key === 'Escape') data.onCancel();
        }}
        onBlur={() => (title.trim() ? data.onSubmit(title.trim()) : data.onCancel())}
      />
    </div>
  );
}

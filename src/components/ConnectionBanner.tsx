import { RefreshCw, WifiOff } from 'lucide-react';
import { useStore } from '../store/store';

/** 连接状态提示：断网时暂停编辑；实时通道重连时仅轻提示（仍可编辑） */
export function ConnectionBanner() {
  const online = useStore((s) => s.online);
  const realtime = useStore((s) => s.realtime);
  if (!online) {
    return (
      <div className="conn-banner offline" role="status" data-testid="conn-banner">
        <WifiOff size={15} />网络已断开：暂时只能查看，编辑已暂停。恢复连接后会自动同步最新数据。
      </div>
    );
  }
  if (realtime === 'reconnecting') {
    return (
      <div className="conn-banner reconnecting" role="status" data-testid="conn-banner">
        <RefreshCw size={14} className="spin" />实时同步正在重连，暂时看不到其他成员的即时变化；你的修改仍会正常保存。
      </div>
    );
  }
  return null;
}

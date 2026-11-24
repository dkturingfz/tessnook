import { avatarColor, initials } from './format';

/** 成员头像：颜色由用户 id 决定，同一个人在所有地方颜色一致 */
export function Avatar({ id, name, size = 'sm', title, ring }: {
  id: string; name: string; size?: 'xs' | 'sm' | 'md'; title?: string; ring?: boolean;
}) {
  return (
    <span className={`avatar ${size} ${ring ? 'ring' : ''}`} style={{ background: avatarColor(id) }} title={title ?? name}>
      {initials(name)}
    </span>
  );
}

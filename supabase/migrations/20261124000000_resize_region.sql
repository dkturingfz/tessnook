-- ============================================================================
-- Tessnook —— 区域缩放（区域尺寸与区域内条目位置在同一事务中更新）
-- 条目新位置由前端按 domain/layout.scaleWithRegion 计算，这里只负责校验与原子提交。
-- 本迁移可重复执行。
-- ============================================================================

create or replace function public.resize_region(
  p_region uuid, p_x double precision, p_y double precision,
  p_width double precision, p_height double precision, p_version int, p_moves jsonb
) returns jsonb language plpgsql as $$
declare r regions; cs jsonb; mv jsonb;
begin
  select * into r from regions where id = p_region for update;
  if r.id is null then perform public.conflict(); end if;
  perform public.require_editor(r.workspace_id);
  if r.version <> p_version then perform public.conflict(); end if;
  update regions set x = p_x, y = p_y, width = p_width, height = p_height
   where id = p_region returning * into r;
  cs := public.cs_up(public.cs_empty(), 'regions', to_jsonb(r));
  -- 复用 move_items：同样的权限、版本与卡片堆规则，同一事务
  mv := public.move_items(r.workspace_id, coalesce(p_moves, '[]'::jsonb));
  return jsonb_set(cs, '{upserts}', (cs->'upserts') || (mv->'upserts'));
end $$;

-- 新函数默认对 PUBLIC 可执行：与其他 RPC 一致，只允许已登录用户调用
revoke execute on function public.resize_region(uuid, double precision, double precision, double precision, double precision, int, jsonb) from public, anon;
grant execute on function public.resize_region(uuid, double precision, double precision, double precision, double precision, int, jsonb) to authenticated;

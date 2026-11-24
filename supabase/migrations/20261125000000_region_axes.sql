-- ============================================================================
-- Tessnook —— 区域轴模板
-- template：轴模板；axis_config：自定义模板的轴名、象限名与“横轴表示紧急程度”开关。
-- 名称长度等细则由业务层 domain/axes.ts 校验；这里约束取值范围、结构与大小。
-- 本迁移可重复执行。
-- ============================================================================

alter table public.regions add column if not exists template text not null default 'eisenhower';
alter table public.regions add column if not exists axis_config jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'regions_template_check') then
    alter table public.regions add constraint regions_template_check
      check (template in ('eisenhower', 'value_effort', 'impact_confidence', 'custom'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'regions_axis_config_check') then
    alter table public.regions add constraint regions_axis_config_check check (
      axis_config is null or (
        jsonb_typeof(axis_config) = 'object'
        and octet_length(axis_config::text) <= 1000
        and jsonb_typeof(axis_config->'x') = 'string' and length(btrim(axis_config->>'x')) between 1 and 12
        and jsonb_typeof(axis_config->'y') = 'string' and length(btrim(axis_config->>'y')) between 1 and 12
        and jsonb_typeof(axis_config->'quadrants') = 'object'
        and length(btrim(axis_config->'quadrants'->>'Q1')) between 1 and 16
        and length(btrim(axis_config->'quadrants'->>'Q2')) between 1 and 16
        and length(btrim(axis_config->'quadrants'->>'Q3')) between 1 and 16
        and length(btrim(axis_config->'quadrants'->>'Q4')) between 1 and 16
        and jsonb_typeof(axis_config->'urgency_x') = 'boolean'
      ));
  end if;
  -- 自定义模板必须带配置
  if not exists (select 1 from pg_constraint where conname = 'regions_custom_needs_config') then
    alter table public.regions add constraint regions_custom_needs_config
      check (template <> 'custom' or axis_config is not null);
  end if;
end $$;

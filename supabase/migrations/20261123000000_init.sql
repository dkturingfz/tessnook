-- ============================================================================
-- 空间化协作看板 V1 —— 数据库初始化
-- PostgreSQL 为唯一可信数据源；RLS 负责权限；事务性 RPC 负责跨表一致性与版本检查。
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 用户资料
-- ---------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null,
  display_name text not null,
  created_at   timestamptz not null default now()
);

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email,
          coalesce(nullif(new.raw_user_meta_data->>'display_name', ''), split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 工作空间与成员
-- ---------------------------------------------------------------------------
create type public.member_role as enum ('owner', 'editor', 'viewer');
create type public.quadrant as enum ('Q1', 'Q2', 'Q3', 'Q4');
create type public.event_status as enum ('active', 'completed');

create table public.workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(name) between 1 and 120),
  revision   bigint not null default 0,          -- 每次业务写入 +1，用于断线校准
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  role         public.member_role not null,
  joined_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index on public.workspace_members (user_id);

create table public.workspace_invitations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email        text,                                -- 为空表示任何持有链接的人
  role         public.member_role not null check (role <> 'owner'),
  token_hash   text not null unique,                -- 只保存凭证哈希
  invited_by   uuid not null references public.profiles(id),
  expires_at   timestamptz not null,
  accepted_by  uuid references public.profiles(id),
  accepted_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- 权限辅助函数（security definer 以避免 RLS 递归）
create or replace function public.member_role_of(ws uuid) returns public.member_role
language sql stable security definer set search_path = public as $$
  select role from public.workspace_members where workspace_id = ws and user_id = auth.uid()
$$;
create or replace function public.is_member(ws uuid) returns boolean
language sql stable as $$ select public.member_role_of(ws) is not null $$;
create or replace function public.can_edit(ws uuid) returns boolean
language sql stable as $$ select public.member_role_of(ws) in ('owner', 'editor') $$;
create or replace function public.is_owner(ws uuid) returns boolean
language sql stable as $$ select public.member_role_of(ws) = 'owner' $$;

-- ---------------------------------------------------------------------------
-- 业务表。所有表都带 workspace_id，并用 (id, workspace_id) 复合外键防止跨空间引用。
-- ---------------------------------------------------------------------------
create table public.regions (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text not null default '四象限区域',
  x double precision not null default 0,
  y double precision not null default 0,
  width  double precision not null default 1200 check (width  >= 200),
  height double precision not null default 800  check (height >= 200),
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id)
);

create table public.stacks (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name         text,
  x double precision not null,
  y double precision not null,
  region_id    uuid,
  quadrant     public.quadrant,
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (region_id, workspace_id) references public.regions(id, workspace_id) on delete set null (region_id)
);

create table public.events (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title        text not null check (length(title) between 1 and 500),
  description  text not null default '',
  status       public.event_status not null default 'active',
  labels       text[] not null default '{}',
  color        text,
  due_date     date,
  region_id    uuid,
  quadrant     public.quadrant,
  x double precision not null default 0,
  y double precision not null default 0,
  stack_id     uuid,
  archived_at  timestamptz,
  archived_by  uuid references public.profiles(id),
  created_by   uuid references public.profiles(id) default auth.uid(),
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (region_id, workspace_id) references public.regions(id, workspace_id) on delete set null (region_id),
  foreign key (stack_id,  workspace_id) references public.stacks(id,  workspace_id) on delete set null (stack_id),
  check (stack_id is null or archived_at is null)    -- 归档事件不能留在卡片堆中
);
create index on public.events (workspace_id) where archived_at is null;
create index on public.events (workspace_id, archived_at desc) where archived_at is not null;
create index on public.events (stack_id) where stack_id is not null;
create index on public.events (region_id) where region_id is not null;

create table public.lists (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  event_id     uuid not null,
  title        text not null check (length(title) between 1 and 200),
  position     double precision not null,
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  unique (id, event_id),
  foreign key (event_id, workspace_id) references public.events(id, workspace_id) on delete cascade
);
create index on public.lists (event_id, position);

create table public.tasks (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  event_id     uuid not null,
  list_id      uuid not null,
  title        text not null check (length(title) between 1 and 500),
  description  text not null default '',
  labels       text[] not null default '{}',
  due_date     date,
  assignee_id  uuid references public.profiles(id) on delete set null,
  done         boolean not null default false,
  position     double precision not null,
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, workspace_id),
  foreign key (event_id, workspace_id) references public.events(id, workspace_id) on delete cascade,
  -- 任务所在列表必须属于同一个事件包（V1 不支持跨事件包移动任务）
  foreign key (list_id, event_id) references public.lists(id, event_id) on delete cascade
);
create index on public.tasks (list_id, position);
create index on public.tasks (workspace_id);

create table public.checklist_items (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  event_id     uuid not null,
  task_id      uuid not null,
  text         text not null default '',
  done         boolean not null default false,
  position     double precision not null,
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (event_id, workspace_id) references public.events(id, workspace_id) on delete cascade,
  foreign key (task_id,  workspace_id) references public.tasks(id,  workspace_id) on delete cascade
);
create index on public.checklist_items (task_id, position);

create table public.activity_log (
  id           bigserial primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id     uuid references public.profiles(id) on delete set null,
  action       text not null,
  entity_type  text not null,
  entity_id    uuid not null,
  summary      text not null,
  created_at   timestamptz not null default now()
);
create index on public.activity_log (workspace_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 通用触发器：版本号、修订号、象限一致性、活动记录
-- ---------------------------------------------------------------------------
create or replace function public.bump_version() returns trigger language plpgsql as $$
begin
  new.version    := old.version + 1;
  new.updated_at := now();
  return new;
end $$;

create or replace function public.bump_revision() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws uuid := coalesce(new.workspace_id, old.workspace_id);
begin
  update public.workspaces set revision = revision + 1 where id = ws;
  return null;
end $$;

-- 不在区域中时象限必须为空（区域被删除时外键只会置空 region_id）
create or replace function public.normalize_quadrant() returns trigger language plpgsql as $$
begin
  if new.region_id is null then new.quadrant := null; end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['regions','stacks','events','lists','tasks','checklist_items'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.bump_version()', t || '_version', t);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.bump_revision()', t || '_revision', t);
  end loop;
end $$;

create trigger events_quadrant before insert or update on public.events
  for each row execute function public.normalize_quadrant();
create trigger stacks_quadrant before insert or update on public.stacks
  for each row execute function public.normalize_quadrant();

create or replace function public.log_activity(ws uuid, act text, etype text, eid uuid, msg text) returns void
language sql security definer set search_path = public as $$
  insert into public.activity_log (workspace_id, actor_id, action, entity_type, entity_id, summary)
  values (ws, auth.uid(), act, etype, eid, msg)
$$;

create or replace function public.events_activity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_activity(new.workspace_id, 'event.created', 'event', new.id, format('创建事件包「%s」', new.title));
  else
    if new.status is distinct from old.status then
      perform public.log_activity(new.workspace_id,
        case when new.status = 'completed' then 'event.completed' else 'event.reopened' end, 'event', new.id,
        format('%s「%s」', case when new.status = 'completed' then '完成' else '重新打开' end, new.title));
    end if;
    if new.archived_at is not null and old.archived_at is null then
      perform public.log_activity(new.workspace_id, 'event.archived', 'event', new.id, format('归档「%s」', new.title));
    elsif new.archived_at is null and old.archived_at is not null then
      perform public.log_activity(new.workspace_id, 'event.restored', 'event', new.id, format('恢复「%s」', new.title));
    end if;
  end if;
  return null;
end $$;
create trigger events_activity after insert or update on public.events
  for each row execute function public.events_activity();

create or replace function public.tasks_activity() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.done and not old.done then
    perform public.log_activity(new.workspace_id, 'task.done', 'task', new.id, format('完成任务「%s」', new.title));
  end if;
  return null;
end $$;
create trigger tasks_activity after update on public.tasks
  for each row execute function public.tasks_activity();

-- ---------------------------------------------------------------------------
-- 行级安全
-- ---------------------------------------------------------------------------
alter table public.profiles              enable row level security;
alter table public.workspaces            enable row level security;
alter table public.workspace_members     enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.regions               enable row level security;
alter table public.stacks                enable row level security;
alter table public.events                enable row level security;
alter table public.lists                 enable row level security;
alter table public.tasks                 enable row level security;
alter table public.checklist_items       enable row level security;
alter table public.activity_log          enable row level security;

-- 资料：本人，或与本人同属某个工作空间的成员可见
create policy profiles_select on public.profiles for select using (
  id = auth.uid() or exists (
    select 1 from public.workspace_members a join public.workspace_members b using (workspace_id)
    where a.user_id = auth.uid() and b.user_id = profiles.id));
create policy profiles_update on public.profiles for update using (id = auth.uid());

create policy workspaces_select on public.workspaces for select using (public.is_member(id));
create policy workspaces_update on public.workspaces for update using (public.is_owner(id));
create policy workspaces_delete on public.workspaces for delete using (public.is_owner(id));
-- 创建工作空间走 create_workspace RPC（需要同时写入 Owner 成员关系）

create policy members_select on public.workspace_members for select using (public.is_member(workspace_id));
-- 成员增删改只走 RPC

create policy invitations_select on public.workspace_invitations for select using (public.is_owner(workspace_id));

do $$
declare t text;
begin
  foreach t in array array['regions','stacks','events','lists','tasks','checklist_items'] loop
    execute format('create policy %I on public.%I for select using (public.is_member(workspace_id))', t || '_select', t);
    execute format('create policy %I on public.%I for insert with check (public.can_edit(workspace_id))', t || '_insert', t);
    execute format('create policy %I on public.%I for update using (public.can_edit(workspace_id)) with check (public.can_edit(workspace_id))', t || '_update', t);
  end loop;
end $$;
-- 删除：事件包与区域的永久删除仅限 Owner；看板内容 Editor 可删除；卡片堆只经 RPC 解散
create policy events_delete  on public.events  for delete using (public.is_owner(workspace_id));
create policy regions_delete on public.regions for delete using (public.is_owner(workspace_id));
create policy lists_delete   on public.lists   for delete using (public.can_edit(workspace_id));
create policy tasks_delete   on public.tasks   for delete using (public.can_edit(workspace_id));
create policy checklist_items_delete on public.checklist_items for delete using (public.can_edit(workspace_id));

create policy activity_select on public.activity_log for select using (public.is_member(workspace_id));

-- workspace_id 不允许被修改（防止把对象“搬”到别的空间）
create or replace function public.forbid_workspace_change() returns trigger language plpgsql as $$
begin
  if new.workspace_id <> old.workspace_id then raise exception 'workspace_id is immutable'; end if;
  return new;
end $$;
do $$
declare t text;
begin
  foreach t in array array['regions','stacks','events','lists','tasks','checklist_items'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.forbid_workspace_change()', t || '_ws_immutable', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- RPC 工具：变更集（与前端 ChangeSet 结构一致）
-- ---------------------------------------------------------------------------
create or replace function public.cs_up(cs jsonb, tbl text, row_data jsonb) returns jsonb
language sql immutable as $$
  select jsonb_set(cs, '{upserts}', (cs->'upserts') || jsonb_build_array(jsonb_build_object('table', tbl, 'row', row_data)))
$$;
create or replace function public.cs_del(cs jsonb, tbl text, rid uuid) returns jsonb
language sql immutable as $$
  select jsonb_set(cs, '{deletes}', (cs->'deletes') || jsonb_build_array(jsonb_build_object('table', tbl, 'id', rid)))
$$;
create or replace function public.cs_empty() returns jsonb
language sql immutable as $$ select '{"upserts":[],"deletes":[]}'::jsonb $$;

create or replace function public.require_editor(ws uuid) returns void language plpgsql stable as $$
begin
  if not public.can_edit(ws) then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
end $$;

-- 统一的冲突错误：前端识别 VERSION_CONFLICT
create or replace function public.conflict() returns void language plpgsql as $$
begin
  raise exception 'VERSION_CONFLICT' using errcode = 'P0409';
end $$;

-- ---------------------------------------------------------------------------
-- 工作空间与成员 RPC
-- ---------------------------------------------------------------------------
create or replace function public.create_workspace(p_name text) returns public.workspaces
language plpgsql security definer set search_path = public as $$
declare ws public.workspaces;
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED' using errcode = '42501'; end if;
  insert into workspaces (name, created_by) values (p_name, auth.uid()) returning * into ws;
  insert into workspace_members (workspace_id, user_id, role) values (ws.id, auth.uid(), 'owner');
  insert into regions (workspace_id, name) values (ws.id, '近期工作');
  select * into ws from workspaces where id = ws.id;
  return ws;
end $$;

create or replace function public.invite_member(p_workspace uuid, p_email text, p_role public.member_role)
returns text language plpgsql security definer set search_path = public as $$
declare tok text := encode(gen_random_bytes(24), 'hex');
begin
  if not public.is_owner(p_workspace) then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  if p_role = 'owner' then raise exception '不能直接邀请 Owner'; end if;
  insert into workspace_invitations (workspace_id, email, role, token_hash, invited_by, expires_at)
  values (p_workspace, nullif(lower(trim(p_email)), ''), p_role, encode(digest(tok, 'sha256'), 'hex'),
          auth.uid(), now() + interval '7 days');
  perform public.log_activity(p_workspace, 'member.invited', 'workspace', p_workspace,
    format('邀请 %s 以 %s 身份加入', coalesce(p_email, '链接持有人'), p_role));
  return tok;    -- 明文凭证只返回这一次
end $$;

create or replace function public.accept_invitation(p_token text) returns uuid
language plpgsql security definer set search_path = public as $$
declare inv workspace_invitations; me profiles;
begin
  select * into me from profiles where id = auth.uid();
  if me.id is null then raise exception 'NOT_AUTHENTICATED' using errcode = '42501'; end if;
  select * into inv from workspace_invitations
   where token_hash = encode(digest(p_token, 'sha256'), 'hex') for update;
  if inv.id is null or inv.accepted_at is not null then raise exception '邀请无效或已被使用'; end if;
  if inv.expires_at < now() then raise exception '邀请已过期'; end if;
  if inv.email is not null and inv.email <> lower(me.email) then raise exception '该邀请属于其他邮箱'; end if;
  insert into workspace_members (workspace_id, user_id, role) values (inv.workspace_id, me.id, inv.role)
    on conflict (workspace_id, user_id) do nothing;
  update workspace_invitations set accepted_by = me.id, accepted_at = now() where id = inv.id;
  perform public.log_activity(inv.workspace_id, 'member.joined', 'member', me.id, format('%s 加入了工作空间', me.display_name));
  return inv.workspace_id;
end $$;

create or replace function public.set_member_role(p_workspace uuid, p_user uuid, p_role public.member_role)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner(p_workspace) then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  perform 1 from workspace_members where workspace_id = p_workspace for update;   -- 串行化角色变更
  if p_role <> 'owner' and (select role from workspace_members where workspace_id = p_workspace and user_id = p_user) = 'owner'
     and (select count(*) from workspace_members where workspace_id = p_workspace and role = 'owner') <= 1 then
    raise exception '工作空间至少需要一个 Owner';
  end if;
  update workspace_members set role = p_role where workspace_id = p_workspace and user_id = p_user;
  if not found then raise exception '成员不存在'; end if;
  perform public.log_activity(p_workspace, 'member.role_changed', 'member', p_user, format('成员角色调整为 %s', p_role));
end $$;

create or replace function public.remove_member(p_workspace uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_user <> auth.uid() and not public.is_owner(p_workspace) then
    raise exception 'PERMISSION_DENIED' using errcode = '42501';
  end if;
  perform 1 from workspace_members where workspace_id = p_workspace for update;
  if (select role from workspace_members where workspace_id = p_workspace and user_id = p_user) = 'owner'
     and (select count(*) from workspace_members where workspace_id = p_workspace and role = 'owner') <= 1 then
    raise exception '不能移除最后一个 Owner';
  end if;
  delete from workspace_members where workspace_id = p_workspace and user_id = p_user;
  perform public.log_activity(p_workspace, 'member.removed', 'member', p_user, '成员被移除');
end $$;

-- ---------------------------------------------------------------------------
-- 画布 RPC（security invoker：RLS 依然生效，另加显式权限与版本检查）
-- ---------------------------------------------------------------------------
create or replace function public.create_event(
  p_workspace uuid, p_title text, p_x double precision, p_y double precision,
  p_region uuid, p_quadrant public.quadrant, p_default_lists boolean
) returns jsonb language plpgsql as $$
declare e events; l lists; cs jsonb := public.cs_empty(); i int := 0; t text;
begin
  perform public.require_editor(p_workspace);
  insert into events (workspace_id, title, x, y, region_id, quadrant)
  values (p_workspace, p_title, p_x, p_y, p_region, p_quadrant) returning * into e;
  cs := public.cs_up(cs, 'events', to_jsonb(e));
  if p_default_lists then
    foreach t in array array['待办', '进行中', '已完成'] loop
      i := i + 1;
      insert into lists (workspace_id, event_id, title, position) values (p_workspace, e.id, t, i * 1024) returning * into l;
      cs := public.cs_up(cs, 'lists', to_jsonb(l));
    end loop;
  end if;
  return cs;
end $$;

-- p_moves: [{kind:'event'|'stack', id, x, y, region_id, quadrant, version}]
create or replace function public.move_items(p_workspace uuid, p_moves jsonb) returns jsonb
language plpgsql as $$
declare m jsonb; e events; s stacks; cs jsonb := public.cs_empty();
        nx double precision; ny double precision; dx double precision; dy double precision;
        rid uuid; q public.quadrant;
begin
  perform public.require_editor(p_workspace);
  for m in select * from jsonb_array_elements(p_moves) loop
    nx := (m->>'x')::double precision; ny := (m->>'y')::double precision;
    rid := nullif(m->>'region_id', '')::uuid; q := nullif(m->>'quadrant', '')::public.quadrant;
    if m->>'kind' = 'event' then
      update events set x = nx, y = ny, region_id = rid, quadrant = q
       where id = (m->>'id')::uuid and workspace_id = p_workspace
         and version = (m->>'version')::int and stack_id is null
      returning * into e;
      if e.id is null then perform public.conflict(); end if;
      cs := public.cs_up(cs, 'events', to_jsonb(e));
      e := null;
    else
      select * into s from stacks where id = (m->>'id')::uuid and workspace_id = p_workspace for update;
      if s.id is null or s.version <> (m->>'version')::int then perform public.conflict(); end if;
      dx := nx - s.x; dy := ny - s.y;
      update stacks set x = nx, y = ny, region_id = rid, quadrant = q where id = s.id returning * into s;
      cs := public.cs_up(cs, 'stacks', to_jsonb(s));
      for e in update events set x = x + dx, y = y + dy, region_id = rid, quadrant = q
                where stack_id = s.id returning * loop
        cs := public.cs_up(cs, 'events', to_jsonb(e));
      end loop;
      s := null;
    end if;
  end loop;
  return cs;
end $$;

create or replace function public.move_region(p_region uuid, p_x double precision, p_y double precision, p_version int)
returns jsonb language plpgsql as $$
declare r regions; e events; s stacks; cs jsonb := public.cs_empty(); dx double precision; dy double precision;
begin
  select * into r from regions where id = p_region for update;
  if r.id is null then perform public.conflict(); end if;
  perform public.require_editor(r.workspace_id);
  if r.version <> p_version then perform public.conflict(); end if;
  dx := p_x - r.x; dy := p_y - r.y;
  update regions set x = p_x, y = p_y where id = p_region returning * into r;
  cs := public.cs_up(cs, 'regions', to_jsonb(r));
  for e in update events set x = x + dx, y = y + dy where region_id = p_region returning * loop
    cs := public.cs_up(cs, 'events', to_jsonb(e));
  end loop;
  for s in update stacks set x = x + dx, y = y + dy where region_id = p_region returning * loop
    cs := public.cs_up(cs, 'stacks', to_jsonb(s));
  end loop;
  return cs;
end $$;

-- 删除区域：Editor 可执行（区域只是组织容器，事件包会保留在原坐标、归属清空）
create or replace function public.delete_region(p_region uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r regions; e events; s stacks; cs jsonb := public.cs_empty();
begin
  select * into r from regions where id = p_region for update;
  if r.id is null then return cs; end if;
  perform public.require_editor(r.workspace_id);
  for e in update events set region_id = null where region_id = p_region returning * loop
    cs := public.cs_up(cs, 'events', to_jsonb(e));
  end loop;
  for s in update stacks set region_id = null where region_id = p_region returning * loop
    cs := public.cs_up(cs, 'stacks', to_jsonb(s));
  end loop;
  delete from regions where id = p_region;
  return public.cs_del(cs, 'regions', p_region);
end $$;

create or replace function public.create_stack(p_workspace uuid, p_event_ids uuid[], p_name text)
returns jsonb language plpgsql as $$
declare s stacks; top events; e events; cs jsonb := public.cs_empty(); n int;
begin
  perform public.require_editor(p_workspace);
  if coalesce(array_length(p_event_ids, 1), 0) < 2 then raise exception '至少选择两个事件包才能堆叠'; end if;
  -- 锁定全部成员，按固定顺序避免死锁
  perform 1 from events where id = any(p_event_ids) order by id for update;
  select count(*) into n from events
   where id = any(p_event_ids) and workspace_id = p_workspace and archived_at is null and stack_id is null;
  if n <> array_length(p_event_ids, 1) then
    raise exception '事件包不可堆叠（已归档、已在其他卡片堆中或不属于该空间）';
  end if;
  select count(distinct (coalesce(region_id::text, '-') || coalesce(quadrant::text, '-'))) into n
    from events where id = any(p_event_ids);
  if n > 1 then raise exception '只能堆叠同一象限（或同在区域外）的事件包'; end if;
  select * into top from events where id = p_event_ids[1];
  insert into stacks (workspace_id, name, x, y, region_id, quadrant)
  values (p_workspace, p_name, top.x, top.y, top.region_id, top.quadrant) returning * into s;
  cs := public.cs_up(cs, 'stacks', to_jsonb(s));
  for e in update events set stack_id = s.id where id = any(p_event_ids) returning * loop
    cs := public.cs_up(cs, 'events', to_jsonb(e));
  end loop;
  return cs;
end $$;

-- 解除堆叠：成员以 3 列网格在堆位置展开（与前端 fanOut 一致：220 宽 + 16 间距，104 高 + 16 间距）
create or replace function public.unstack(p_stack uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s stacks; e events; cs jsonb := public.cs_empty(); i int := 0;
begin
  select * into s from stacks where id = p_stack for update;
  if s.id is null then perform public.conflict(); end if;
  perform public.require_editor(s.workspace_id);
  for e in select * from events where stack_id = p_stack order by updated_at, id loop
    update events set stack_id = null,
           x = s.x + (i % 3) * 236, y = s.y + (i / 3) * 120,
           region_id = s.region_id, quadrant = s.quadrant
     where id = e.id returning * into e;
    cs := public.cs_up(cs, 'events', to_jsonb(e));
    i := i + 1;
  end loop;
  delete from stacks where id = p_stack;
  return public.cs_del(cs, 'stacks', p_stack);
end $$;

-- 卡片堆成员不足 2 个时解散（内部使用）
create or replace function public.dissolve_if_small(p_stack uuid, cs jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s stacks; e events;
begin
  select * into s from stacks where id = p_stack for update;
  if s.id is null then return cs; end if;
  if (select count(*) from events where stack_id = p_stack) >= 2 then return cs; end if;
  for e in update events set stack_id = null, x = s.x, y = s.y, region_id = s.region_id, quadrant = s.quadrant
            where stack_id = p_stack returning * loop
    cs := public.cs_up(cs, 'events', to_jsonb(e));
  end loop;
  delete from stacks where id = p_stack;
  return public.cs_del(cs, 'stacks', p_stack);
end $$;

-- ---------------------------------------------------------------------------
-- 看板与生命周期 RPC
-- ---------------------------------------------------------------------------
create or replace function public.move_task(p_task uuid, p_list uuid, p_position double precision, p_version int)
returns jsonb language plpgsql as $$
declare t tasks;
begin
  select * into t from tasks where id = p_task for update;
  if t.id is null then perform public.conflict(); end if;
  perform public.require_editor(t.workspace_id);
  if t.version <> p_version then perform public.conflict(); end if;
  if not exists (select 1 from lists where id = p_list and event_id = t.event_id) then
    raise exception 'V1 不支持跨事件包移动任务';
  end if;
  update tasks set list_id = p_list, position = p_position where id = p_task returning * into t;
  return public.cs_up(public.cs_empty(), 'tasks', to_jsonb(t));
end $$;

create or replace function public.archive_event(p_event uuid, p_version int, p_complete boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e events; s stacks; cs jsonb := public.cs_empty(); sid uuid;
begin
  select * into e from events where id = p_event for update;
  if e.id is null then perform public.conflict(); end if;
  perform public.require_editor(e.workspace_id);
  if e.version <> p_version then perform public.conflict(); end if;
  sid := e.stack_id;
  if sid is not null then select * into s from stacks where id = sid; end if;
  update events set archived_at = now(), archived_by = auth.uid(), stack_id = null,
         status = case when p_complete then 'completed'::event_status else status end,
         x = coalesce(s.x, x), y = coalesce(s.y, y)
   where id = p_event returning * into e;
  cs := public.cs_up(cs, 'events', to_jsonb(e));
  if sid is not null then cs := public.dissolve_if_small(sid, cs); end if;
  return cs;
end $$;

create or replace function public.restore_event(p_event uuid) returns jsonb
language plpgsql as $$
declare e events;
begin
  select * into e from events where id = p_event for update;
  if e.id is null then perform public.conflict(); end if;
  perform public.require_editor(e.workspace_id);
  if e.archived_at is null then return public.cs_empty(); end if;
  -- 原区域若已删除，region_id 已为空；保留原坐标，客户端恢复后定位到该位置
  update events set archived_at = null, archived_by = null where id = p_event returning * into e;
  return public.cs_up(public.cs_empty(), 'events', to_jsonb(e));
end $$;

-- 仅允许已登录用户调用 RPC（Postgres 默认把函数执行权授予 PUBLIC）
revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated;

-- ---------------------------------------------------------------------------
-- 实时：业务表加入 supabase_realtime 发布；删除事件需要完整旧行
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['workspaces','workspace_members','regions','stacks','events','lists','tasks','checklist_items'] loop
    execute format('alter table public.%I replica identity full', t);
  end loop;
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table
      public.workspaces, public.workspace_members, public.regions, public.stacks,
      public.events, public.lists, public.tasks, public.checklist_items;
  end if;
end $$;

-- ============================================================================
-- Tessnook —— 允许删除用户账户
-- 之前若干外键没有 ON DELETE 行为：用户只要创建过空间、发过/接受过邀请、或在任何空间里创建/归档过事件包，
-- 其账户就无法删除。现在这些“是谁做的”字段在用户删除后置空，业务数据保留。
-- 若删除导致某个空间没有 Owner：提升资历最久的 Editor（没有则提升资历最久的成员）；若已无任何成员，删除该空间。
-- 本迁移可重复执行。
-- ============================================================================

alter table public.workspaces alter column created_by drop not null;
alter table public.workspace_invitations alter column invited_by drop not null;

alter table public.workspaces drop constraint if exists workspaces_created_by_fkey,
  add constraint workspaces_created_by_fkey foreign key (created_by) references public.profiles(id) on delete set null;
alter table public.workspace_invitations drop constraint if exists workspace_invitations_invited_by_fkey,
  add constraint workspace_invitations_invited_by_fkey foreign key (invited_by) references public.profiles(id) on delete set null;
alter table public.workspace_invitations drop constraint if exists workspace_invitations_accepted_by_fkey,
  add constraint workspace_invitations_accepted_by_fkey foreign key (accepted_by) references public.profiles(id) on delete set null;
alter table public.events drop constraint if exists events_archived_by_fkey,
  add constraint events_archived_by_fkey foreign key (archived_by) references public.profiles(id) on delete set null;
alter table public.events drop constraint if exists events_created_by_fkey,
  add constraint events_created_by_fkey foreign key (created_by) references public.profiles(id) on delete set null;

create or replace function public.ensure_owner_after_member_delete() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare promote uuid;
begin
  -- 整个空间正在被删除（级联删除成员）时不处理
  if not exists (select 1 from workspaces where id = old.workspace_id) then return null; end if;
  if exists (select 1 from workspace_members where workspace_id = old.workspace_id and role = 'owner') then return null; end if;
  select user_id into promote from workspace_members where workspace_id = old.workspace_id
   order by case role when 'editor' then 0 else 1 end, joined_at, user_id limit 1;
  if promote is null then
    delete from workspaces where id = old.workspace_id;
  else
    update workspace_members set role = 'owner' where workspace_id = old.workspace_id and user_id = promote;
    perform public.log_activity(old.workspace_id, 'member.role_changed', 'member', promote, '原 Owner 的账户已删除，该成员自动成为 Owner');
  end if;
  return null;
end $$;

drop trigger if exists workspace_members_ensure_owner on public.workspace_members;
create trigger workspace_members_ensure_owner after delete on public.workspace_members
  for each row execute function public.ensure_owner_after_member_delete();

revoke execute on function public.ensure_owner_after_member_delete() from public, anon;

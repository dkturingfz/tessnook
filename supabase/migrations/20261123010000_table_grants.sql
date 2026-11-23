-- ============================================================================
-- Tessnook —— 表级权限
-- 新建的 Supabase 项目不会自动把 public 下新表的权限授予 anon / authenticated。
-- RLS 只负责“能看到哪些行”，前提是角色先拥有表级权限，因此这里显式授权：
--   * authenticated：可读写业务表，具体到哪些行由 RLS 策略决定；
--   * anon（未登录）：不授予任何表权限。
-- 本迁移可重复执行。
-- ============================================================================

grant usage on schema public to authenticated;

-- 业务表：读写由 RLS 进一步限制
grant select, insert, update, delete on
  public.regions, public.stacks, public.events,
  public.lists, public.tasks, public.checklist_items
to authenticated;

-- 只读或仅经 RPC 修改的表：只授予需要的权限，其余操作没有对应的 RLS 策略也会被拒绝
grant select, update on public.profiles   to authenticated;   -- 只能改自己的资料（RLS）
grant select, update, delete on public.workspaces to authenticated;   -- 改名/删除仅 Owner（RLS）；创建走 RPC
grant select on public.workspace_members     to authenticated;  -- 成员变更只走 RPC
grant select on public.workspace_invitations to authenticated;  -- 仅 Owner 可见（RLS）；创建/接受走 RPC
grant select on public.activity_log          to authenticated;  -- 只由触发器写入

-- 未登录用户不能直接访问任何表（即使项目开启了旧的默认授权）
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

-- 仅用于在纯 PostgreSQL 上测试迁移：模拟 Supabase 的 auth schema、角色与扩展布局
-- Supabase 把 pgcrypto 等扩展装在 extensions schema 中，这里保持一致
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public, auth to anon, authenticated;
-- 注意：新建的 Supabase 项目不再自动给 anon/authenticated 授予 public 下新表的权限，
-- 这里同样不设默认授权，迁移必须显式 GRANT。

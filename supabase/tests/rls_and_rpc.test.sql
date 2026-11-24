-- 在加载 auth_stub.sql 与迁移之后运行：psql -v ON_ERROR_STOP=1 -f 本文件
\set QUIET on
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'alice@example.com', '{"display_name":"Alice"}'),
  ('00000000-0000-0000-0000-00000000000b', 'bob@example.com',   '{"display_name":"Bob"}'),
  ('00000000-0000-0000-0000-00000000000c', 'carol@example.com', '{}');

create temp table ctx (k text primary key, v text);
grant all on ctx to authenticated;

set role authenticated;
-- Alice 创建工作空间
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
insert into ctx select 'ws', (public.create_workspace('Alice 团队')).id;
insert into ctx select 'region', id from regions where workspace_id = (select v::uuid from ctx where k='ws');
do $$
declare ws uuid := (select v::uuid from ctx where k='ws'); r uuid := (select v::uuid from ctx where k='region');
        cs jsonb; e1 uuid; e2 uuid; e3 uuid;
begin
  cs := create_event(ws, '写论文', 100, 100, r, 'Q1', true);
  assert jsonb_array_length(cs->'upserts') = 4, 'event + 3 lists';
  e1 := (cs->'upserts'->0->'row'->>'id')::uuid;
  e2 := ((create_event(ws, '做实验', 400, 100, r, 'Q1', false))->'upserts'->0->'row'->>'id')::uuid;
  e3 := ((create_event(ws, '区域外', 5000, 5000, null, 'Q2', false))->'upserts'->0->'row'->>'id')::uuid;
  assert (select quadrant from events where id = e3) is null, 'quadrant normalized when no region';
  insert into ctx values ('e1', e1), ('e2', e2), ('e3', e3);
  assert (select count(*) from activity_log where workspace_id = ws and action = 'event.created') = 3;
  assert (select revision from workspaces where id = ws) > 0, 'revision bumped';
end $$;

-- 版本冲突：用过期版本移动会失败
do $$
declare ws uuid := (select v::uuid from ctx where k='ws'); e1 uuid := (select v::uuid from ctx where k='e1');
begin
  perform move_items(ws, jsonb_build_array(jsonb_build_object('kind','event','id',e1,'x',10,'y',20,'region_id',null,'quadrant',null,'version',1)));
  assert (select version from events where id = e1) = 2;
  begin
    perform move_items(ws, jsonb_build_array(jsonb_build_object('kind','event','id',e1,'x',99,'y',99,'region_id',null,'quadrant',null,'version',1)));
    raise exception 'should have conflicted';
  exception when sqlstate 'P0409' then null;
  end;
  assert (select x from events where id = e1) = 10, 'stale write did not overwrite';
end $$;

-- 堆叠约束：不同象限不能堆叠；同象限可以；归档后堆解散
do $$
declare ws uuid := (select v::uuid from ctx where k='ws'); r uuid := (select v::uuid from ctx where k='region');
        e1 uuid := (select v::uuid from ctx where k='e1'); e2 uuid := (select v::uuid from ctx where k='e2');
        e3 uuid := (select v::uuid from ctx where k='e3'); cs jsonb; sid uuid; v int;
begin
  begin
    perform create_stack(ws, array[e2, e3], null);
    raise exception 'should reject cross-quadrant stack';
  exception when others then
    if sqlerrm = 'should reject cross-quadrant stack' then raise; end if;
  end;
  -- e1 移回 Q1 再堆叠
  select version into v from events where id = e1;
  perform move_items(ws, jsonb_build_array(jsonb_build_object('kind','event','id',e1,'x',120,'y',120,'region_id',r,'quadrant','Q1','version',v)));
  cs := create_stack(ws, array[e1, e2], '实验相关');
  sid := (select stack_id from events where id = e1);
  assert sid is not null and (select stack_id from events where id = e2) = sid;
  -- 移动卡片堆 → 成员象限跟随
  select version into v from stacks where id = sid;
  perform move_items(ws, jsonb_build_array(jsonb_build_object('kind','stack','id',sid,'x',900,'y',700,'region_id',r,'quadrant','Q4','version',v)));
  assert (select bool_and(quadrant = 'Q4') from events where stack_id = sid), 'members follow stack quadrant';
  -- 归档一个成员 → 只剩一个，堆自动解散
  select version into v from events where id = e1;
  cs := archive_event(e1, v, true);
  assert (select archived_at is not null and stack_id is null and status = 'completed' from events where id = e1);
  assert not exists (select 1 from stacks where id = sid), 'stack dissolved';
  assert (select stack_id is null and quadrant = 'Q4' from events where id = e2);
  perform restore_event(e1);
  assert (select archived_at is null from events where id = e1);
  assert exists (select 1 from activity_log where action = 'event.archived' and entity_id = e1);
end $$;

-- 区域缩放：区域与条目位置原子更新；条目版本过期时整体回滚
do $$
declare ws uuid := (select v::uuid from ctx where k='ws'); r regions; e events; cs jsonb;
begin
  select * into r from regions where id = (select v::uuid from ctx where k='region');
  select * into e from events where id = (select v::uuid from ctx where k='e3');
  cs := resize_region(r.id, r.x, r.y, r.width * 2, r.height, r.version,
    jsonb_build_array(jsonb_build_object('kind','event','id',e.id,'x',e.x + 10,'y',e.y,'region_id',r.id,'quadrant','Q2','version',e.version)));
  assert (select width from regions where id = r.id) = r.width * 2, 'region resized';
  assert (select x from events where id = e.id) = e.x + 10, 'item moved';
  assert jsonb_array_length(cs->'upserts') = 2, 'changeset has region + event';
  -- 区域版本正确、但条目版本已过期（e 仍是旧记录）：区域已更新的部分也必须整体回滚
  select * into r from regions where id = r.id;
  begin
    perform resize_region(r.id, r.x, r.y, r.width / 2, r.height, r.version,
      jsonb_build_array(jsonb_build_object('kind','event','id',e.id,'x',0,'y',0,'region_id',r.id,'quadrant','Q2','version',e.version)));
    raise exception 'should conflict';
  exception when sqlstate 'P0409' then null;
  end;
  assert (select width from regions where id = r.id) = r.width, 'region update rolled back with the stale item move';
  -- 还原，后续测试依赖原有区域/事件状态
  select * into r from regions where id = r.id;
  select * into e from events where id = e.id;
  perform resize_region(r.id, r.x, r.y, r.width / 2, r.height, r.version,
    jsonb_build_array(jsonb_build_object('kind','event','id',e.id,'x',e.x - 10,'y',e.y,'region_id',null,'quadrant',null,'version',e.version)));
end $$;

-- 看板：任务跨列移动；不能移到别的事件包的列
do $$
declare ws uuid := (select v::uuid from ctx where k='ws'); e1 uuid := (select v::uuid from ctx where k='e1');
        e2 uuid := (select v::uuid from ctx where k='e2');
        l1 uuid; l2 uuid; other uuid; t tasks;
begin
  select id into l1 from lists where event_id = e1 order by position limit 1;
  select id into l2 from lists where event_id = e1 order by position desc limit 1;
  insert into lists (workspace_id, event_id, title, position) values (ws, e2, '其他', 1) returning id into other;
  insert into tasks (workspace_id, event_id, list_id, title, position) values (ws, e1, l1, '查文献', 1024) returning * into t;
  perform move_task(t.id, l2, 2048, t.version);
  assert (select list_id from tasks where id = t.id) = l2;
  begin
    perform move_task(t.id, other, 1, t.version + 1);
    raise exception 'should reject cross-event move';
  exception when others then
    if sqlerrm = 'should reject cross-event move' then raise; end if;
  end;
  -- 直接插入跨事件包任务也会被复合外键拒绝
  begin
    insert into tasks (workspace_id, event_id, list_id, title, position) values (ws, e1, other, 'x', 1);
    raise exception 'fk should reject';
  exception when foreign_key_violation then null;
  end;
  update tasks set done = true where id = t.id;
  assert exists (select 1 from activity_log where action = 'task.done' and entity_id = t.id);
end $$;

-- 邀请 Bob 为 Viewer
insert into ctx select 'tok', invite_member((select v::uuid from ctx where k='ws'), 'bob@example.com', 'viewer');

-- Carol：不是成员，看不到任何数据，也不能用别人的邀请
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
do $$
begin
  assert (select count(*) from workspaces) = 0, 'carol sees no workspace';
  assert (select count(*) from events) = 0, 'carol sees no events';
  assert (select count(*) from activity_log) = 0;
  begin
    perform accept_invitation((select v from ctx where k='tok'));
    raise exception 'carol should not accept bob invite';
  exception when others then
    if sqlerrm like 'carol should%' then raise; end if;
  end;
  -- 也不能往别人空间里写
  begin
    insert into events (workspace_id, title) values ((select v::uuid from ctx where k='ws'), 'hack');
    raise exception 'rls should block';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Bob 接受邀请，作为 Viewer 只能读
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare ws uuid; n int;
begin
  ws := accept_invitation((select v from ctx where k='tok'));
  assert ws = (select v::uuid from ctx where k='ws');
  assert (select count(*) from events) = 3, 'viewer reads events';
  update events set title = 'viewer edit' where workspace_id = ws;
  get diagnostics n = row_count;
  assert n = 0, 'viewer update filtered by RLS';
  begin
    perform create_event(ws, 'x', 0, 0, null, null, false);
    raise exception 'viewer cannot create';
  exception when insufficient_privilege then null;
  end;
  begin
    perform accept_invitation((select v from ctx where k='tok'));
    raise exception 'token reused';
  exception when others then
    if sqlerrm = 'token reused' then raise; end if;
  end;
  begin
    perform set_member_role(ws, auth.uid(), 'owner');
    raise exception 'viewer cannot promote self';
  exception when insufficient_privilege then null;
  end;
end $$;

-- Alice 把 Bob 升为 Editor；Bob 可以编辑但不能永久删除事件包
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select set_member_role((select v::uuid from ctx where k='ws'), '00000000-0000-0000-0000-00000000000b', 'editor');
do $$
begin
  begin
    perform remove_member((select v::uuid from ctx where k='ws'), auth.uid());
    raise exception 'last owner removed';
  exception when others then
    if sqlerrm = 'last owner removed' then raise; end if;
  end;
end $$;
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare ws uuid := (select v::uuid from ctx where k='ws'); n int;
begin
  update events set title = 'Bob 改的' where id = (select v::uuid from ctx where k='e3');
  get diagnostics n = row_count; assert n = 1, 'editor can update';
  delete from events where id = (select v::uuid from ctx where k='e3');
  get diagnostics n = row_count; assert n = 0, 'editor cannot hard delete events';
  -- 删除区域：事件包保留，归属清空
  perform delete_region((select v::uuid from ctx where k='region'));
  assert (select count(*) from events where workspace_id = ws and (region_id is not null or quadrant is not null)) = 0;
end $$;

-- Alice 移除 Bob 后，Bob 立即失去读权限
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
select remove_member((select v::uuid from ctx where k='ws'), '00000000-0000-0000-0000-00000000000b');
set request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$ begin assert (select count(*) from events) = 0, 'removed member loses access'; end $$;

reset role;
select 'ALL DATABASE TESTS PASSED' as result;

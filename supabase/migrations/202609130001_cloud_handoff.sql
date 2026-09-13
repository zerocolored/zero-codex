-- The database owns handoff identity; SQLite continues to own local processes.
-- Apply using the project SQL editor or Supabase migrations, never a worker key.
begin;
create table if not exists public.zerochan_spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.zerochan_members (
  user_id uuid primary key references auth.users(id),
  space_id uuid not null references public.zerochan_spaces(id),
  slack_team_id text not null,
  slack_bot_id text not null,
  enabled boolean not null default true,
  unique(space_id, slack_team_id, slack_bot_id)
);
create table if not exists public.zerochan_handoffs (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.zerochan_spaces(id),
  slack_team_id text not null,
  channel_id text not null,
  thread_ts text not null,
  owner_id uuid not null references public.zerochan_members(user_id),
  epoch bigint not null default 1,
  state text not null check (state in ('active', 'saving', 'waiting', 'importing', 'completed')),
  checkpoint_key text,
  checkpoint_digest text,
  checkpoint_bytes bigint,
  reset_at timestamptz,
  updated_at timestamptz not null default now(),
  unique(space_id, slack_team_id, channel_id, thread_ts),
  check (checkpoint_digest is null or checkpoint_digest ~ '^[a-f0-9]{64}$'),
  check (checkpoint_bytes is null or checkpoint_bytes between 1 and 536870912)
);
create table if not exists public.zerochan_handoff_events (
  space_id uuid not null references public.zerochan_spaces(id),
  event_id text not null,
  handoff_id uuid not null references public.zerochan_handoffs(id),
  actor_id uuid not null references public.zerochan_members(user_id),
  epoch bigint not null,
  created_at timestamptz not null default now(),
  primary key(space_id,event_id)
);
alter table public.zerochan_spaces enable row level security;
alter table public.zerochan_members enable row level security;
alter table public.zerochan_handoffs enable row level security;
alter table public.zerochan_handoff_events enable row level security;
revoke all on public.zerochan_spaces, public.zerochan_members,
  public.zerochan_handoffs, public.zerochan_handoff_events from anon, authenticated;
grant select on public.zerochan_members, public.zerochan_handoffs to authenticated;
create policy zerochan_member_self on public.zerochan_members for select to authenticated
  using (user_id = auth.uid() and enabled);
create policy zerochan_handoff_member on public.zerochan_handoffs for select to authenticated
  using (exists(select 1 from public.zerochan_members m where m.user_id=auth.uid()
    and m.enabled and m.space_id=zerochan_handoffs.space_id
    and m.slack_team_id=zerochan_handoffs.slack_team_id));

-- Worker registration is an administrator operation. A caller cannot choose
-- another space/bot identity by changing RPC arguments.
create or replace function public.zerochan_claim_thread(p_channel text,p_thread text)
returns public.zerochan_handoffs language plpgsql security definer set search_path='' as $$
declare m public.zerochan_members; h public.zerochan_handoffs;
begin
  select * into strict m from public.zerochan_members where user_id=auth.uid() and enabled;
  if p_channel !~ '^[CGD][A-Z0-9]+$' or p_thread !~ '^[0-9]+\.[0-9]+$' then
    raise exception 'invalid thread';
  end if;
  insert into public.zerochan_handoffs(space_id,slack_team_id,channel_id,thread_ts,owner_id,state)
    values(m.space_id,m.slack_team_id,p_channel,p_thread,m.user_id,'active')
    on conflict(space_id,slack_team_id,channel_id,thread_ts) do nothing;
  select * into strict h from public.zerochan_handoffs where space_id=m.space_id
    and slack_team_id=m.slack_team_id and channel_id=p_channel and thread_ts=p_thread for update;
  if h.owner_id<>m.user_id or h.state not in ('active','completed') then
    raise exception 'thread has another owner or is waiting';
  end if;
  update public.zerochan_handoffs set state='active',updated_at=now() where id=h.id returning * into h;
  return h;
end $$;

-- Only call saving after the local writer and its owned child processes have
-- quiesced. No timeout/lease expiry grants another worker execution rights.
create or replace function public.zerochan_checkpoint(p_id uuid,p_epoch bigint,p_state text,
  p_key text default null,p_digest text default null,p_bytes bigint default null,p_reset timestamptz default null)
returns public.zerochan_handoffs language plpgsql security definer set search_path='' as $$
declare m public.zerochan_members; h public.zerochan_handoffs;
begin
  select * into strict m from public.zerochan_members where user_id=auth.uid() and enabled;
  select * into strict h from public.zerochan_handoffs where id=p_id and space_id=m.space_id for update;
  if h.owner_id<>m.user_id or h.epoch is distinct from p_epoch then raise exception 'stale owner'; end if;
  if p_state='saving' and h.state in ('active','saving') then
    update public.zerochan_handoffs set state='saving',reset_at=coalesce(p_reset,reset_at),updated_at=now() where id=h.id returning * into h;
  elsif p_state='waiting' and h.state in ('saving','waiting') then
    if p_key is null or p_digest is null or p_bytes is null
      or p_key <> m.space_id::text || '/' || m.user_id::text || '/' || h.id::text || '/' || p_digest || '.json'
      or not exists(select 1 from storage.objects where bucket_id='zerochan-handoffs' and name=p_key)
      then raise exception 'checkpoint object missing or invalid'; end if;
    if h.state='waiting' and (h.checkpoint_key is distinct from p_key or h.checkpoint_digest is distinct from p_digest)
      then raise exception 'checkpoint already published'; end if;
    update public.zerochan_handoffs set state='waiting',checkpoint_key=p_key,checkpoint_digest=p_digest,
      checkpoint_bytes=p_bytes,reset_at=coalesce(p_reset,reset_at),updated_at=now() where id=h.id returning * into h;
  else raise exception 'invalid checkpoint transition'; end if;
  return h;
end $$;

create or replace function public.zerochan_take_handoff(p_id uuid,p_epoch bigint,p_event text)
returns public.zerochan_handoffs language plpgsql security definer set search_path='' as $$
declare m public.zerochan_members; h public.zerochan_handoffs; e public.zerochan_handoff_events;
begin
  select * into strict m from public.zerochan_members where user_id=auth.uid() and enabled;
  if p_event is null or length(p_event) not between 1 and 200 then raise exception 'invalid event'; end if;
  select * into strict h from public.zerochan_handoffs where id=p_id and space_id=m.space_id
    and slack_team_id=m.slack_team_id for update;
  select * into e from public.zerochan_handoff_events where space_id=m.space_id and event_id=p_event;
  if found then
    if e.actor_id<>m.user_id or e.handoff_id<>h.id or e.epoch<>h.epoch or h.owner_id<>m.user_id
      then raise exception 'event already used'; end if;
    return h;
  end if;
  if h.state<>'waiting' or h.epoch is distinct from p_epoch then raise exception 'handoff is not available'; end if;
  if h.owner_id=m.user_id and h.reset_at>now() then raise exception 'usage limit has not reset'; end if;
  update public.zerochan_handoffs set owner_id=m.user_id,epoch=epoch+1,state='importing',reset_at=null,updated_at=now()
    where id=h.id returning * into h;
  insert into public.zerochan_handoff_events(space_id,event_id,handoff_id,actor_id,epoch)
    values(m.space_id,p_event,h.id,m.user_id,h.epoch);
  return h;
end $$;
create or replace function public.zerochan_activate_handoff(p_id uuid,p_epoch bigint)
returns public.zerochan_handoffs language plpgsql security definer set search_path='' as $$
declare h public.zerochan_handoffs;
begin
  update public.zerochan_handoffs target set state='active',updated_at=now()
    where target.id=p_id and target.epoch=p_epoch and target.owner_id=auth.uid() and target.state in ('importing','active')
    and exists(select 1 from public.zerochan_members m where m.user_id=auth.uid() and m.enabled)
    returning target.* into h;
  if not found then raise exception 'stale owner'; end if;
  return h;
end $$;
revoke all on function public.zerochan_claim_thread(text,text) from public, anon;
revoke all on function public.zerochan_checkpoint(uuid,bigint,text,text,text,bigint,timestamptz) from public, anon;
revoke all on function public.zerochan_take_handoff(uuid,bigint,text) from public, anon;
revoke all on function public.zerochan_activate_handoff(uuid,bigint) from public, anon;
grant execute on function public.zerochan_claim_thread(text,text),
  public.zerochan_checkpoint(uuid,bigint,text,text,text,bigint,timestamptz),
  public.zerochan_take_handoff(uuid,bigint,text),public.zerochan_activate_handoff(uuid,bigint) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('zerochan-handoffs','zerochan-handoffs',false,536870912,array['application/json'])
 on conflict(id) do nothing;
create policy zerochan_blob_read on storage.objects for select to authenticated using (
 bucket_id='zerochan-handoffs' and exists(select 1 from public.zerochan_members m
 where m.user_id=auth.uid() and m.enabled and (storage.foldername(name))[1]=m.space_id::text
 and exists(select 1 from public.zerochan_handoffs h where h.space_id=m.space_id
   and h.slack_team_id=m.slack_team_id and h.id::text=(storage.foldername(name))[3])));
create policy zerochan_blob_create on storage.objects for insert to authenticated with check (
 bucket_id='zerochan-handoffs' and exists(select 1 from public.zerochan_members m
 where m.user_id=auth.uid() and m.enabled and (storage.foldername(name))[1]=m.space_id::text
 and (storage.foldername(name))[2]=m.user_id::text));
-- No worker UPDATE/DELETE policy: published checkpoints are immutable.
commit;

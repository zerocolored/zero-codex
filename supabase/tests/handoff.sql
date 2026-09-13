-- Run against an isolated fixture/project after the migration. Roll back all
-- test data. Auth/storage base schemas and authenticated role must exist.
begin;
insert into auth.users(id) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3');
insert into public.zerochan_spaces(id,name) values
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1','fixture'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2','foreign');
insert into public.zerochan_members(user_id,space_id,slack_team_id,slack_bot_id) values
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1','T1','U1'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1','T1','U2'),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2','T1','U3');
set local role authenticated;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',true);
do $$
declare h public.zerochan_handoffs; k text;
begin
 h:=public.zerochan_claim_thread('C1','1.0');
 if h.epoch<>1 or h.state<>'active' then raise exception 'claim assertion'; end if;
 begin
   perform public.zerochan_checkpoint(h.id,null,'saving');
   raise exception 'null epoch accepted';
 exception when raise_exception then
   if sqlerrm='null epoch accepted' then raise; end if;
 end;
 h:=public.zerochan_checkpoint(h.id,h.epoch,'saving',p_reset=>now()+interval '1 hour');
 begin
   perform public.zerochan_checkpoint(h.id,h.epoch,'waiting','missing',repeat('a',64),10);
   raise exception 'missing blob accepted';
 exception when raise_exception then
   if sqlerrm='missing blob accepted' then raise; end if;
 end;
 k:=h.space_id::text||'/'||h.owner_id::text||'/'||h.id::text||'/'||repeat('a',64)||'.json';
 insert into storage.objects(bucket_id,name) values('zerochan-handoffs',k);
 h:=public.zerochan_checkpoint(h.id,h.epoch,'waiting',k,repeat('a',64),10);
 if h.state<>'waiting' then raise exception 'publish assertion'; end if;
 if h.reset_at<=now() or h.reset_at is null then raise exception 'quota reset lost on publish'; end if;
 begin
   perform public.zerochan_take_handoff(h.id,h.epoch,'early-self-resume');
   raise exception 'early quota resume accepted';
 exception when raise_exception then
   if sqlerrm='early quota resume accepted' then raise; end if;
 end;
end $$;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',true);
do $$ begin
 if exists(select 1 from public.zerochan_handoffs) then raise exception 'foreign thread visible'; end if;
 if exists(select 1 from storage.objects where bucket_id='zerochan-handoffs') then raise exception 'foreign blob visible'; end if;
end $$;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',true);
do $$
declare h public.zerochan_handoffs; again public.zerochan_handoffs;
begin
 select * into strict h from public.zerochan_handoffs where channel_id='C1';
 begin
   perform public.zerochan_take_handoff(h.id,null,'null-epoch-event');
   raise exception 'null takeover epoch accepted';
 exception when raise_exception then
   if sqlerrm='null takeover epoch accepted' then raise; end if;
 end;
 h:=public.zerochan_take_handoff(h.id,h.epoch,'slack-event-1');
 if h.owner_id<>auth.uid() or h.epoch<>2 or h.state<>'importing' then raise exception 'transfer assertion'; end if;
 if h.reset_at is not null then raise exception 'previous owner quota leaked to recipient'; end if;
 again:=public.zerochan_take_handoff(h.id,1,'slack-event-1');
 if again.epoch<>h.epoch then raise exception 'duplicate event changed epoch'; end if;
 h:=public.zerochan_activate_handoff(h.id,h.epoch);
 if h.state<>'active' then raise exception 'activation assertion'; end if;
end $$;
select set_config('request.jwt.claim.sub','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',true);
do $$
declare h public.zerochan_handoffs;
begin
 select * into strict h from public.zerochan_handoffs where channel_id='C1';
 begin
   perform public.zerochan_take_handoff(h.id,1,'slack-event-2');
   raise exception 'stale owner resumed';
 exception when raise_exception then
   if sqlerrm='stale owner resumed' then raise; end if;
 end;
 begin
   perform public.zerochan_checkpoint(h.id,1,'saving');
   raise exception 'stale owner wrote checkpoint';
 exception when raise_exception then
   if sqlerrm='stale owner wrote checkpoint' then raise; end if;
 end;
end $$;
rollback;
select 'handoff SQL assertions passed' as result;

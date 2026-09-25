-- Local disposable DB only. Roles anon/authenticated must exist locally.
create schema auth;
create schema extensions;
create extension pgcrypto with schema extensions;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create table public.zerochan_spaces(id uuid primary key);
create table public.zerochan_members(user_id uuid primary key references auth.users(id),space_id uuid references public.zerochan_spaces(id),slack_team_id text,slack_bot_id text,enabled boolean default true);

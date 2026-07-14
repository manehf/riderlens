-- RiderLens paid MVP: private analysis library and durable job state.

begin;

create extension if not exists pgcrypto with schema extensions;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.analysis_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  client_record_id text,
  skill_type text not null default 'regular_jump'
    check (skill_type = 'regular_jump'),
  status text not null default 'awaiting_upload'
    check (status in (
      'awaiting_upload',
      'uploading',
      'queued',
      'processing',
      'completed',
      'failed',
      'cancelled',
      'deleting'
    )),
  source_filename text,
  source_content_type text,
  source_size_bytes bigint check (source_size_bytes is null or source_size_bytes >= 0),
  trim_start_seconds numeric(9, 3) not null default 0
    check (trim_start_seconds >= 0),
  trim_end_seconds numeric(9, 3),
  rotation_degrees smallint not null default 0
    check (rotation_degrees in (0, 90, 180, 270)),
  source_object_key text unique,
  clean_object_key text unique,
  skeleton_object_key text unique,
  poster_object_key text unique,
  analysis_object_key text unique,
  frames_object_key text unique,
  analysis_version text,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint analysis_sessions_trim_window_check
    check (trim_end_seconds is null or trim_end_seconds > trim_start_seconds),
  constraint analysis_sessions_user_client_record_unique
    unique (user_id, client_record_id)
);

create table public.analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null unique references public.analysis_sessions(id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  progress smallint not null default 0 check (progress between 0 and 100),
  attempt_count smallint not null default 0 check (attempt_count >= 0),
  max_attempts smallint not null default 3 check (max_attempts between 1 and 10),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  lease_expires_at timestamptz,
  worker_id text,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index analysis_sessions_user_created_idx
  on public.analysis_sessions (user_id, created_at desc);

create index analysis_sessions_status_idx
  on public.analysis_sessions (status, created_at);

create index analysis_jobs_available_idx
  on public.analysis_jobs (available_at, created_at)
  where status = 'queued';

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create trigger analysis_sessions_set_updated_at
before update on public.analysis_sessions
for each row execute function public.set_updated_at();

create trigger analysis_jobs_set_updated_at
before update on public.analysis_jobs
for each row execute function public.set_updated_at();

create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    nullif(left(coalesce(new.raw_user_meta_data ->> 'name', ''), 80), '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

insert into public.profiles (id)
select id from auth.users
on conflict (id) do nothing;

alter table public.profiles enable row level security;
alter table public.analysis_sessions enable row level security;
alter table public.analysis_jobs enable row level security;

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.analysis_sessions from anon, authenticated;
revoke all on table public.analysis_jobs from anon, authenticated;

grant usage on schema public to authenticated;
grant select on table public.profiles to authenticated;
grant update (display_name) on table public.profiles to authenticated;
grant select on table public.analysis_sessions to authenticated;
grant select on table public.analysis_jobs to authenticated;

create policy profiles_select_own
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

create policy profiles_update_own
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy analysis_sessions_select_own
on public.analysis_sessions
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy analysis_jobs_select_own
on public.analysis_jobs
for select
to authenticated
using (
  exists (
    select 1
    from public.analysis_sessions session
    where session.id = analysis_jobs.session_id
      and session.user_id = (select auth.uid())
  )
);

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'analysis-media',
  'analysis-media',
  false,
  536870912,
  array[
    'video/mp4',
    'video/quicktime',
    'image/jpeg',
    'application/json',
    'application/zip',
    'application/x-zip-compressed'
  ]::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Object keys use: <user-id>/<analysis-session-id>/<asset-name>.
create policy analysis_media_select_own
on storage.objects
for select
to authenticated
using (
  bucket_id = 'analysis-media'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and exists (
    select 1
    from public.analysis_sessions session
    where session.id::text = (storage.foldername(name))[2]
      and session.user_id = (select auth.uid())
  )
);

-- The app may upload only the source object for a server-approved session.
-- Generated assets and deletions are handled by the worker with its secret key.
create policy analysis_media_insert_approved_source
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'analysis-media'
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and storage.filename(name) in ('source.mp4', 'source.mov')
  and exists (
    select 1
    from public.analysis_sessions session
    where session.id::text = (storage.foldername(name))[2]
      and session.user_id = (select auth.uid())
      and session.status in ('awaiting_upload', 'uploading')
  )
);

comment on table public.analysis_sessions is
  'User-owned RiderLens analysis records and durable media object keys.';
comment on table public.analysis_jobs is
  'Durable worker state for a single analysis attempt lifecycle per session.';

revoke all on function public.set_updated_at() from public;
revoke all on function public.handle_new_user() from public;

commit;

-- RiderLens MVP Supabase schema
-- Apply in a Supabase SQL editor or via `supabase db push`.

create extension if not exists "pgcrypto";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  skill_type text not null check (skill_type in ('regular_jump', 'bunnyhop', 'manual', 'wheelie', 'drop')),
  status text not null default 'draft' check (status in ('draft', 'uploaded', 'analyzing', 'analysis_failed', 'complete')),
  created_at timestamptz not null default now()
);

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  raw_video_path text not null,
  annotated_video_path text,
  duration_seconds numeric(8, 2),
  fps numeric(8, 2),
  trim_start_seconds numeric(8, 3) not null default 0,
  trim_end_seconds numeric(8, 3),
  crop_preset text not null default 'full_side_view' check (crop_preset in ('full_side_view', 'rider_centered', 'takeoff_landing', 'vertical_social')),
  created_at timestamptz not null default now()
);

create table if not exists public.analysis_jobs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  progress numeric(4, 3) not null default 0,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists public.pose_metrics (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  phase text not null check (phase in ('approach', 'compression', 'takeoff', 'air', 'landing')),
  frame_time numeric(8, 3) not null,
  torso_angle numeric(8, 3),
  hip_angle numeric(8, 3),
  knee_angle numeric(8, 3),
  elbow_angle numeric(8, 3),
  bike_pitch_angle numeric(8, 3),
  confidence numeric(5, 4),
  created_at timestamptz not null default now()
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  summary text not null,
  strengths text[] not null default '{}',
  improvements text[] not null default '{}',
  drills text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists public.share_links (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  token text not null unique,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.bikes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  brand text,
  model text,
  year integer,
  discipline text,
  created_at timestamptz not null default now()
);

create table if not exists public.bike_setups (
  id uuid primary key default gen_random_uuid(),
  bike_id uuid not null references public.bikes(id) on delete cascade,
  name text not null,
  terrain_type text,
  riding_style text,
  rider_weight_with_gear numeric(8, 2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.suspension_settings (
  id uuid primary key default gen_random_uuid(),
  bike_setup_id uuid not null references public.bike_setups(id) on delete cascade,
  fork_model text,
  shock_model text,
  fork_pressure numeric(8, 2),
  shock_pressure numeric(8, 2),
  fork_sag_percent numeric(8, 2),
  shock_sag_percent numeric(8, 2),
  fork_rebound_clicks integer,
  shock_rebound_clicks integer,
  fork_lsc_clicks integer,
  fork_hsc_clicks integer,
  shock_lsc_clicks integer,
  shock_hsc_clicks integer,
  fork_tokens integer,
  shock_tokens integer,
  notes text
);

create table if not exists public.cockpit_settings (
  id uuid primary key default gen_random_uuid(),
  bike_setup_id uuid not null references public.bike_setups(id) on delete cascade,
  bar_width numeric(8, 2),
  stem_length numeric(8, 2),
  stem_spacers numeric(8, 2),
  bar_roll_angle numeric(8, 2),
  brake_lever_angle numeric(8, 2),
  saddle_height numeric(8, 2),
  saddle_angle numeric(8, 2),
  notes text
);

create table if not exists public.tire_settings (
  id uuid primary key default gen_random_uuid(),
  bike_setup_id uuid not null references public.bike_setups(id) on delete cascade,
  front_tire_model text,
  rear_tire_model text,
  front_tire_pressure numeric(8, 2),
  rear_tire_pressure numeric(8, 2),
  front_tire_width numeric(8, 2),
  rear_tire_width numeric(8, 2),
  conditions text,
  notes text
);

create table if not exists public.service_records (
  id uuid primary key default gen_random_uuid(),
  bike_id uuid not null references public.bikes(id) on delete cascade,
  service_type text not null,
  service_date date,
  odometer_or_hours numeric(10, 2),
  shop_name text,
  mechanic_name text,
  notes text,
  next_due_at date
);

create table if not exists public.setup_share_links (
  id uuid primary key default gen_random_uuid(),
  bike_setup_id uuid not null references public.bike_setups(id) on delete cascade,
  token text not null unique,
  permission text not null default 'view' check (permission in ('view', 'comment', 'edit')),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.tool_measurements (
  id uuid primary key default gen_random_uuid(),
  bike_id uuid not null references public.bikes(id) on delete cascade,
  bike_setup_id uuid references public.bike_setups(id) on delete set null,
  measurement_type text not null,
  value numeric(10, 3) not null,
  unit text not null check (unit in ('deg', '%')),
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists sessions_user_id_idx on public.sessions(user_id);
create index if not exists videos_session_id_idx on public.videos(session_id);
create index if not exists analysis_jobs_session_id_idx on public.analysis_jobs(session_id);
create index if not exists pose_metrics_session_id_idx on public.pose_metrics(session_id);
create index if not exists bikes_user_id_idx on public.bikes(user_id);
create index if not exists bike_setups_bike_id_idx on public.bike_setups(bike_id);

alter table public.profiles enable row level security;
alter table public.sessions enable row level security;
alter table public.videos enable row level security;
alter table public.analysis_jobs enable row level security;
alter table public.pose_metrics enable row level security;
alter table public.reports enable row level security;
alter table public.share_links enable row level security;
alter table public.bikes enable row level security;
alter table public.bike_setups enable row level security;
alter table public.suspension_settings enable row level security;
alter table public.cockpit_settings enable row level security;
alter table public.tire_settings enable row level security;
alter table public.service_records enable row level security;
alter table public.setup_share_links enable row level security;
alter table public.tool_measurements enable row level security;

create policy "profiles owner read" on public.profiles for select using (auth.uid() = id);
create policy "profiles owner write" on public.profiles for update using (auth.uid() = id);

create policy "sessions owner all" on public.sessions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "bikes owner all" on public.bikes for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "videos session owner all" on public.videos for all
using (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid()))
with check (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid()));

create policy "analysis jobs session owner read" on public.analysis_jobs for select
using (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid()));

create policy "pose metrics session owner read" on public.pose_metrics for select
using (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid()));

create policy "reports session owner read" on public.reports for select
using (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid()));

create policy "share links session owner all" on public.share_links for all
using (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid()))
with check (exists (select 1 from public.sessions s where s.id = session_id and s.user_id = auth.uid()));

create policy "bike setup owner all" on public.bike_setups for all
using (exists (select 1 from public.bikes b where b.id = bike_id and b.user_id = auth.uid()))
with check (exists (select 1 from public.bikes b where b.id = bike_id and b.user_id = auth.uid()));

create policy "suspension setup owner all" on public.suspension_settings for all
using (exists (
  select 1 from public.bike_setups bs
  join public.bikes b on b.id = bs.bike_id
  where bs.id = bike_setup_id and b.user_id = auth.uid()
))
with check (exists (
  select 1 from public.bike_setups bs
  join public.bikes b on b.id = bs.bike_id
  where bs.id = bike_setup_id and b.user_id = auth.uid()
));

create policy "cockpit setup owner all" on public.cockpit_settings for all
using (exists (
  select 1 from public.bike_setups bs
  join public.bikes b on b.id = bs.bike_id
  where bs.id = bike_setup_id and b.user_id = auth.uid()
))
with check (exists (
  select 1 from public.bike_setups bs
  join public.bikes b on b.id = bs.bike_id
  where bs.id = bike_setup_id and b.user_id = auth.uid()
));

create policy "tire setup owner all" on public.tire_settings for all
using (exists (
  select 1 from public.bike_setups bs
  join public.bikes b on b.id = bs.bike_id
  where bs.id = bike_setup_id and b.user_id = auth.uid()
))
with check (exists (
  select 1 from public.bike_setups bs
  join public.bikes b on b.id = bs.bike_id
  where bs.id = bike_setup_id and b.user_id = auth.uid()
));

create policy "service records owner all" on public.service_records for all
using (exists (select 1 from public.bikes b where b.id = bike_id and b.user_id = auth.uid()))
with check (exists (select 1 from public.bikes b where b.id = bike_id and b.user_id = auth.uid()));

create policy "setup share owner all" on public.setup_share_links for all
using (exists (
  select 1 from public.bike_setups bs
  join public.bikes b on b.id = bs.bike_id
  where bs.id = bike_setup_id and b.user_id = auth.uid()
))
with check (exists (
  select 1 from public.bike_setups bs
  join public.bikes b on b.id = bs.bike_id
  where bs.id = bike_setup_id and b.user_id = auth.uid()
));

create policy "tool measurements owner all" on public.tool_measurements for all
using (exists (select 1 from public.bikes b where b.id = bike_id and b.user_id = auth.uid()))
with check (exists (select 1 from public.bikes b where b.id = bike_id and b.user_id = auth.uid()));

insert into storage.buckets (id, name, public)
values
  ('raw-videos', 'raw-videos', false),
  ('key-frames', 'key-frames', false),
  ('annotated-videos', 'annotated-videos', false),
  ('shared-reports', 'shared-reports', false)
on conflict (id) do nothing;

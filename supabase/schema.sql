-- Ganttor storage schema.
--
-- One table. A project document is a single JSONB blob rather than a normalised set of
-- task/dependency tables, and that is deliberate: the scheduling engine already treats
-- `Project` as one atomic value (every mutation is a pure `Project -> Project`), so
-- splitting it across tables would buy nothing and cost transactional consistency on
-- every drag. The row is the document.
--
-- `document_version` mirrors DOCUMENT_VERSION in persistence.ts so the client can run its
-- existing migrate() path against a row written by an older build.
--
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).

create extension if not exists "pgcrypto";

create table if not exists public.projects (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references auth.users (id) on delete cascade,
  name             text not null default 'Untitled project',
  document         jsonb not null,
  document_version integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- The list query is always "my projects, most recently touched first".
create index if not exists projects_owner_updated_idx
  on public.projects (owner_id, updated_at desc);

-- ── Row Level Security ───────────────────────────────────────────────────────────────
-- Without this the anon key would read every row in the table. The anon key ships in the
-- browser bundle and is public by design; RLS is what actually protects the data, so it
-- is not optional.

alter table public.projects enable row level security;

drop policy if exists "projects_select_own" on public.projects;
create policy "projects_select_own"
  on public.projects for select
  using (auth.uid() = owner_id);

drop policy if exists "projects_insert_own" on public.projects;
create policy "projects_insert_own"
  on public.projects for insert
  with check (auth.uid() = owner_id);

drop policy if exists "projects_update_own" on public.projects;
create policy "projects_update_own"
  on public.projects for update
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

drop policy if exists "projects_delete_own" on public.projects;
create policy "projects_delete_own"
  on public.projects for delete
  using (auth.uid() = owner_id);

-- ── updated_at ───────────────────────────────────────────────────────────────────────
-- Maintained server-side. The client autosaves on a debounce and must not be trusted to
-- stamp its own ordering key, or a stale tab could sort itself to the top of the list.

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_touch_updated_at on public.projects;
create trigger projects_touch_updated_at
  before update on public.projects
  for each row execute function public.touch_updated_at();

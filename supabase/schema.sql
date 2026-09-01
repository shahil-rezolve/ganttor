-- Ganttor storage schema.
--
-- One table. A project document is a single JSONB blob rather than a normalised set of
-- task/dependency tables, and that is deliberate: the scheduling engine already treats
-- `Project` as one atomic value (every mutation is a pure `Project -> Project`), so
-- splitting it across tables would buy nothing and cost transactional consistency on
-- every drag. The row is the document.
--
-- ── Access model ─────────────────────────────────────────────────────────────────────
-- One flat shared workspace. Every signed-in user sees, opens, edits and deletes every
-- project; there is no per-project ownership and no sharing model. `owner_id` records who
-- created a row and is never an access predicate. The gate is the `authenticated` role
-- itself, so who can reach the data is decided entirely by who can obtain an account —
-- keep email sign-ups disabled (Authentication -> Providers -> Email) and create users by
-- hand, or a stranger can self-register into the workspace.
--
-- `document_version` mirrors DOCUMENT_VERSION in persistence.ts so the client can run its
-- existing migrate() path against a row written by an older build.
--
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query). It is
-- idempotent, and re-running it migrates a table created by an earlier version: the shape
-- is declared in `create table if not exists`, then every later deviation is re-asserted
-- with `alter`, because the `create` is a no-op on an existing table.

create extension if not exists "pgcrypto";

create table if not exists public.projects (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid references auth.users (id) on delete set null default auth.uid(),
  name             text not null default 'Untitled project',
  document         jsonb not null,
  document_version integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ── owner_id is provenance ───────────────────────────────────────────────────────────
-- The default lets an insert inherit the creator from the JWT, so the client never sends
-- the column and an update never mentions it — editing someone else's project leaves the
-- attribution alone.
--
-- `on delete set null`, not `cascade`: removing a departing teammate's auth user must not
-- delete projects the whole team depends on. Losing the attribution is the right amount of
-- damage, and it is why the column has to be nullable.

alter table public.projects alter column owner_id set default auth.uid();
alter table public.projects alter column owner_id drop not null;
alter table public.projects drop constraint if exists projects_owner_id_fkey;
alter table public.projects add constraint projects_owner_id_fkey
  foreign key (owner_id) references auth.users (id) on delete set null;
comment on column public.projects.owner_id is
  'Who created the row. Provenance only — never an access predicate.';

-- Confirm the FK actually moved. `confdeltype` must read 'n' (set null), not 'c'
-- (cascade); if a differently-named constraint survived, the cascade is still live:
--   select conname, confdeltype from pg_constraint
--    where conrelid = 'public.projects'::regclass and contype = 'f';

-- The list query is "every project, most recently touched first" — no owner predicate, so
-- a leading-`owner_id` composite could never serve it.
create index if not exists projects_updated_idx on public.projects (updated_at desc);
drop index if exists public.projects_owner_updated_idx;

-- ── Row Level Security ───────────────────────────────────────────────────────────────
-- Still not optional, and still the thing protecting the data. The anon key ships in the
-- browser bundle and is public by design; `anon` has no policy at all here, so an
-- unauthenticated request reads nothing. What changed is the shape of the grant: these
-- policies are scoped to the *role* rather than the row.
--
-- `to authenticated` rather than `using (auth.role() = 'authenticated')`: role membership
-- instead of a per-row function call, and `auth.role()` is deprecated.

alter table public.projects enable row level security;

-- The old per-owner rules. These drops are what removes them from a live table.
drop policy if exists "projects_select_own" on public.projects;
drop policy if exists "projects_insert_own" on public.projects;
drop policy if exists "projects_update_own" on public.projects;
drop policy if exists "projects_delete_own" on public.projects;

drop policy if exists "projects_select_authenticated" on public.projects;
create policy "projects_select_authenticated"
  on public.projects for select
  to authenticated
  using (true);

drop policy if exists "projects_insert_authenticated" on public.projects;
create policy "projects_insert_authenticated"
  on public.projects for insert
  to authenticated
  with check (true);

drop policy if exists "projects_update_authenticated" on public.projects;
create policy "projects_update_authenticated"
  on public.projects for update
  to authenticated
  using (true)
  with check (true);

drop policy if exists "projects_delete_authenticated" on public.projects;
create policy "projects_delete_authenticated"
  on public.projects for delete
  to authenticated
  using (true);

-- ── updated_at ───────────────────────────────────────────────────────────────────────
-- Maintained server-side. The client autosaves on a debounce and must not be trusted to
-- stamp its own ordering key, or a stale tab could sort itself to the top of the list.
--
-- That matters more now that the workspace is shared: `updated_at` is also the concurrency
-- token. Every guarded save carries the value it last read and the update matches on it,
-- so a stale tab's whole-document write is refused instead of silently discarding a
-- teammate's edits. A client clock could not do that job — this trigger is what makes the
-- token trustworthy.

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

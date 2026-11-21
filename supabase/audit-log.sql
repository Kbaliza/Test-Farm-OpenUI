-- ============================================================================
-- The audit log: every add, edit and delete, with who did it and what changed.
--
-- Run via `npx tsx scripts/apply-audit-log.ts` (DIRECT_URL, the session pooler —
-- trigger DDL cannot run through the transaction pooler), or paste into the
-- Supabase SQL editor. Re-runnable: everything is dropped-if-exists first, and
-- the attach loop at the bottom re-points every trigger.
--
-- WHY A TRIGGER, not application code:
--   Seven different things write to this database — the website's server
--   actions, the raw SQL a few of them use, the rider app and the customer app
--   writing straight to Postgres, the checklist API route, four existing
--   triggers, the WhatsApp worker, and the maintenance scripts. Only the
--   database sees all of them. A hook in the application would have covered the
--   first and missed the rest, and "audited except when it isn't" is not an
--   audit trail.
--
-- WHO is resolved in this order: the transaction-local setting the website puts
-- on the wire, then the JWT the mobile apps carry, then nothing — recorded as
-- 'unknown'. A write is never dropped for want of an actor; losing the name is
-- survivable, losing the change is not.
--
-- NOTE for editors: scripts/apply-audit-log.ts splits this file on semicolons
-- outside `$$ ... $$` bodies, toggling on any line containing `$$`. Keep every
-- dollar-quote on a line of its own, never two on one line, and never put `$$`
-- inside a string literal.
-- ============================================================================

-- ── Who is acting ───────────────────────────────────────────────────────────
drop function if exists public.audit_actor() cascade;

create or replace function public.audit_actor(
  out actor_id text,
  out actor_name text,
  out actor_role text,
  out actor_source text
)
language plpgsql
stable
as
$$
declare
  claims text;
  sub    text;
begin
  -- The website. Set transaction-locally by the Prisma client extension, because
  -- the runtime shares pooled connections between requests and a session-level
  -- setting would put one person's name on another person's edit.
  actor_id := nullif(current_setting('app.actor_id', true), '');
  if actor_id is not null then
    actor_source := 'web';
    actor_name := nullif(current_setting('app.actor_name', true), '');
    actor_role := nullif(current_setting('app.actor_role', true), '');
    if actor_name is null then
      select u.name, u.role::text into actor_name, actor_role from "User" u where u.id = actor_id;
    end if;
    return;
  end if;

  -- The rider and customer apps, arriving through PostgREST with a JWT.
  -- auth.uid() is not called directly: it raises on paths with no JWT, and this
  -- function must never be the reason a write fails.
  claims := nullif(current_setting('request.jwt.claims', true), '');
  if claims is not null then
    sub := (claims::jsonb) ->> 'sub';
    if sub is not null then
      select u.id, u.name, u.role::text into actor_id, actor_name, actor_role
        from "User" u where u."supabaseId" = sub;
      if actor_id is not null then
        actor_source := 'mobile';
        return;
      end if;
      -- A customer login has no User row of its own.
      select 'customer:' || c.id, c.name into actor_id, actor_name
        from "Customer" c where c."supabaseId" = sub;
      actor_role := 'CUSTOMER';
      actor_source := 'mobile';
      if actor_id is not null then
        return;
      end if;
      actor_id := 'supabase:' || sub;
      return;
    end if;
  end if;

  actor_source := 'unknown';
  return;
end;
$$;

-- ── Keeping the stored values small and safe ────────────────────────────────
drop function if exists public.audit_shrink(jsonb) cascade;

create or replace function public.audit_shrink(j jsonb)
returns jsonb
language sql
immutable
as
$$
  select case
    when j is null then null
    else (
      select coalesce(jsonb_object_agg(
               key,
               case
                 when jsonb_typeof(value) = 'string' and length(value #>> '{}') > 512
                   then to_jsonb(left(value #>> '{}', 509) || '...')
                 else value
               end
             ), '{}'::jsonb)
        from jsonb_each(j)
       where key not in ('passwordHash', 'supabaseId')
    )
  end;
$$;

-- ── The one writer ──────────────────────────────────────────────────────────
drop function if exists public.audit_row() cascade;

create or replace function public.audit_row()
returns trigger
language plpgsql
security definer
set search_path = public
as
$$
declare
  j_old   jsonb;
  j_new   jsonb;
  changed text[];
  b       jsonb;
  a       jsonb;
  rid     text;
  act     record;
begin
  if TG_OP = 'INSERT' then
    j_new := to_jsonb(NEW);
    rid := j_new ->> 'id';
    a := public.audit_shrink(j_new);
  elsif TG_OP = 'DELETE' then
    j_old := to_jsonb(OLD);
    rid := j_old ->> 'id';
    b := public.audit_shrink(j_old);
  else
    j_old := to_jsonb(OLD);
    j_new := to_jsonb(NEW);
    rid := j_new ->> 'id';

    select coalesce(array_agg(n.key order by n.key), '{}')
      into changed
      from jsonb_each(j_new) n
     where n.key <> 'updatedAt'
       and (j_old -> n.key) is distinct from n.value;

    -- Nothing moved. Saving a form unchanged, or a reconciler rewriting the same
    -- values on every page load, is not a change anyone can act on — and logging
    -- it would bury the ones that are.
    if changed = '{}' then
      return null;
    end if;

    -- Only what changed is kept: two keys instead of sixty, and the page has
    -- nothing to diff when it reads.
    select jsonb_object_agg(k, j_old -> k), jsonb_object_agg(k, j_new -> k)
      into b, a
      from unnest(changed) k;
    b := public.audit_shrink(b);
    a := public.audit_shrink(a);
  end if;

  select * into act from public.audit_actor();

  insert into "AuditLog"
    (id, "tableName", "rowId", operation, "before", "after", "changedFields",
     "actorId", "actorName", "actorRole", "actorSource", "at")
  values
    (gen_random_uuid()::text, TG_TABLE_NAME, rid, TG_OP, b, a, coalesce(changed, '{}'),
     act.actor_id, act.actor_name, act.actor_role, coalesce(act.actor_source, 'unknown'), now());

  return null;
end;
$$;

-- ── Append-only ─────────────────────────────────────────────────────────────
-- REVOKE is not enough on its own: the application connects as the owner of this
-- table, and an owner is not subject to its own grants. The grants below stop the
-- mobile apps; this trigger stops everything else, including an admin, a server
-- action and a raw query.
drop function if exists public.audit_log_immutable() cascade;

create or replace function public.audit_log_immutable()
returns trigger
language plpgsql
as
$$
begin
  if current_setting('app.audit_prune', true) = 'on' then
    return old;
  end if;
  raise exception 'AuditLog is append-only: % is not permitted', TG_OP
    using errcode = '42501';
end;
$$;

drop trigger if exists trg_audit_log_immutable on "AuditLog";

create trigger trg_audit_log_immutable
  before update or delete on "AuditLog"
  for each row execute function public.audit_log_immutable();

-- The mobile apps must not read the log either: it carries every table's values.
revoke all on "AuditLog" from authenticated, anon;

alter table "AuditLog" enable row level security;

-- ── Retention ───────────────────────────────────────────────────────────────
-- The only thing permitted to remove a row. The flag it sets is
-- transaction-local, so it cannot be left switched on.
drop function if exists public.prune_audit_log(int) cascade;

create or replace function public.prune_audit_log(months int default 12)
returns integer
language plpgsql
security definer
set search_path = public
as
$$
declare
  n integer;
begin
  perform set_config('app.audit_prune', 'on', true);
  delete from "AuditLog" where "at" < now() - make_interval(months => months);
  get diagnostics n = row_count;
  perform set_config('app.audit_prune', 'off', true);
  return n;
end;
$$;

revoke all on function public.prune_audit_log(int) from public, anon, authenticated;

-- ── Attach to every business table ──────────────────────────────────────────
-- A deny-list, not an allow-list: a table added next year is audited by the
-- deploy that creates it, with nobody having to remember. This block runs on
-- every deploy, after `prisma migrate deploy`.
--
-- Denied, and why:
--   AuditLog             would log itself
--   WhatsappMessageLog   a send queue that rewrites its own status; machine output
--   WhatsappSession      session and QR state, rewritten constantly, holds credentials
--   DeviceToken          push-token churn on every app launch
--   CustomerNotification machine fan-out; the decision behind it is audited at its source
--   Alert                derived, not decided
--   CustomerPin          a cache of coordinates read from Customer.locationUrl
--   RiderLocation        a rider's latest GPS point, rewritten every few seconds
--   RiderTrackPoint      the GPS path behind it, pruned at 30 days
--   ChecklistCompletion  tick/untick churn that already stores who and when, and is
--   ChecklistNote        pruned at 60 days — a 12-month shadow of a 60-day table
do
$$
declare
  t record;
  denied text[] := array[
    'AuditLog', 'WhatsappMessageLog', 'WhatsappSession', 'DeviceToken',
    'CustomerNotification', 'Alert', 'ChecklistCompletion', 'ChecklistNote',
    'CustomerPin', 'RiderLocation', 'RiderTrackPoint'
  ];
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and left(c.relname, 1) <> '_'
       and not (c.relname = any(denied))
  loop
    execute format('drop trigger if exists trg_audit_row on public.%I', t.relname);
    execute format(
      'create trigger trg_audit_row after insert or update or delete on public.%I for each row execute function public.audit_row()',
      t.relname);
  end loop;

  -- And take it off anything that has since joined the deny-list.
  for t in select unnest(denied) as relname
  loop
    execute format('drop trigger if exists trg_audit_row on public.%I', t.relname);
  end loop;
end
$$;

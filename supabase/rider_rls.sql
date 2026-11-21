-- ============================================================================
-- Banoori Dairy — RLS policies for the RIDER app
-- ============================================================================
-- The existing policies on this DB are written for a CUSTOMER portal: they all
-- match `Customer.supabaseId = auth.uid()`. A rider is NOT a customer — his
-- auth.uid() lives in `User.supabaseId` — so under those policies a rider sees
-- ZERO rows and every write is denied.
--
-- This file ADDS rider-scoped policies alongside the customer ones. Postgres
-- ORs permissive policies together, so the customer portal keeps working
-- untouched. Nothing here is dropped or altered on the customer side.
--
-- Rider ownership chain:
--   auth.uid() -> User.supabaseId -> Rider -> Shift.riderId -> Route -> RouteStop
--
-- The my_*() helpers are SECURITY DEFINER so their internal reads bypass RLS.
-- That is deliberate: it prevents infinite policy recursion (a policy on table A
-- querying table B whose policy queries table A). They are STABLE and return
-- only the calling rider's own ids, so they leak nothing.
--
-- Idempotent: safe to re-run. Run as the DB owner (Supabase SQL editor).
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Helper functions: the id sets that belong to the calling rider
-- ---------------------------------------------------------------------------

create or replace function public.my_rider_ids()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(r.id), '{}'::text[])
  from "Rider" r
  join "User" u on u.id = r."userId"
  where u."supabaseId" = (auth.uid())::text
    and r.active and u.active
$$;

create or replace function public.my_shift_ids()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(s.id), '{}'::text[])
  from "Shift" s
  where s."riderId" = any(public.my_rider_ids())
$$;

-- NOTE: there used to be a my_routestop_ids() helper here returning an array of every
-- stop the rider owned, with policies matching `id = any(...)`. Postgres re-ran it per
-- row: reading 62 stops cost 333k buffer reads and hit the statement timeout, so the app
-- could not open a route at all. The policies below test each row against the Route
-- primary key instead, and wrap the small helpers in `any (select unnest(f()))` so they
-- are evaluated once per query rather than once per row.

create or replace function public.my_route_ids()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(r.id), '{}'::text[])
  from "Route" r
  where r."shiftId" = any(public.my_shift_ids())
$$;

-- Membership is Customer.shiftId, exactly as the web computes it. This used to union in
-- customers matched on Customer.riderId as well — a column the web writes once at creation
-- and never updates. That union forced a sequential scan of the whole table, and the planner
-- evaluates this helper three to four times per query, which is what made every rider screen
-- slow. Verified against live data: no customer is reachable by riderId alone, so nothing is
-- hidden by dropping it.
create or replace function public.my_customer_ids()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(c.id), '{}'::text[])
  from "Customer" c
  where c."shiftId" = any(public.my_shift_ids())
$$;

create or replace function public.my_order_ids()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(o.id), '{}'::text[])
  from "CustomerOrder" o
  where o."customerId" = any(public.my_customer_ids())
$$;

create or replace function public.my_sample_ids()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(sl.id), '{}'::text[])
  from "SampleLead" sl
  where sl."shiftId" = any(public.my_shift_ids())
$$;

create or replace function public.my_invoice_ids()
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(i.id), '{}'::text[])
  from "Invoice" i
  where i."customerId" = any(public.my_customer_ids())
$$;

grant execute on function public.my_rider_ids()     to authenticated;
grant execute on function public.my_shift_ids()     to authenticated;
grant execute on function public.my_route_ids()     to authenticated;
grant execute on function public.my_customer_ids()  to authenticated;
grant execute on function public.my_order_ids()     to authenticated;
grant execute on function public.my_sample_ids()    to authenticated;
grant execute on function public.my_invoice_ids()   to authenticated;


-- ---------------------------------------------------------------------------
-- Core route: the rider must read his customers, their schedule, and his stops
-- ---------------------------------------------------------------------------

drop policy if exists rider_customer_select on "Customer";
-- Test the row's own shiftId against the handful of shifts he runs, rather than asking
-- whether its id appears in an array of several hundred customer ids.
create policy rider_customer_select on "Customer" for select to authenticated
using ("shiftId" = any (select unnest(public.my_shift_ids())));

drop policy if exists rider_custprod_select on "CustomerProduct";
create policy rider_custprod_select on "CustomerProduct" for select to authenticated
using ("customerId" = any (select unnest(public.my_customer_ids())));

drop function if exists public.my_routestop_ids();

drop policy if exists rider_routestop_select on "RouteStop";
create policy rider_routestop_select on "RouteStop" for select to authenticated
using (
  "riderId" = any (select unnest(public.my_rider_ids()))
   or exists (select 1 from "Route" rt where rt.id = "RouteStop"."routeId"
              and rt."shiftId" = any (select unnest(public.my_shift_ids())))
);

-- deliveredAt / status / skipReason / cashCollected
drop policy if exists rider_routestop_update on "RouteStop";
create policy rider_routestop_update on "RouteStop" for update to authenticated
using      (
  "riderId" = any (select unnest(public.my_rider_ids()))
   or exists (select 1 from "Route" rt where rt.id = "RouteStop"."routeId"
              and rt."shiftId" = any (select unnest(public.my_shift_ids())))
)
with check (
  "riderId" = any (select unnest(public.my_rider_ids()))
   or exists (select 1 from "Route" rt where rt.id = "RouteStop"."routeId"
              and rt."shiftId" = any (select unnest(public.my_shift_ids())))
);

drop policy if exists rider_rsi_select on "RouteStopItem";
create policy rider_rsi_select on "RouteStopItem" for select to authenticated
using (exists (select 1 from "RouteStop" rs join "Route" rt on rt.id = rs."routeId"
        where rs.id = "RouteStopItem"."routeStopId"
          and rt."shiftId" = any (select unnest(public.my_shift_ids()))));

-- actualQty
drop policy if exists rider_rsi_update on "RouteStopItem";
create policy rider_rsi_update on "RouteStopItem" for update to authenticated
using      (exists (select 1 from "RouteStop" rs join "Route" rt on rt.id = rs."routeId"
        where rs.id = "RouteStopItem"."routeStopId"
          and rt."shiftId" = any (select unnest(public.my_shift_ids()))))
with check (exists (select 1 from "RouteStop" rs join "Route" rt on rt.id = rs."routeId"
        where rs.id = "RouteStopItem"."routeStopId"
          and rt."shiftId" = any (select unnest(public.my_shift_ids()))));

-- Nobody generates routes automatically — a human has to save one on the web's Pre-Delivery
-- page, and most days nobody does. When that happens the app builds the day's route itself, so
-- it needs to write the stops. Without them a stop has nowhere to record delivered/skipped or
-- the cash collected, the rider loses his progress the moment he closes the app, and he can
-- deliver the same customer twice.
drop policy if exists rider_routestop_insert on "RouteStop";
create policy rider_routestop_insert on "RouteStop" for insert to authenticated
with check (exists (select 1 from "Route" rt where rt.id = "RouteStop"."routeId"
                    and rt."shiftId" = any (select unnest(public.my_shift_ids()))));

drop policy if exists rider_rsi_insert on "RouteStopItem";
create policy rider_rsi_insert on "RouteStopItem" for insert to authenticated
with check (exists (select 1 from "RouteStop" rs join "Route" rt on rt.id = rs."routeId"
        where rs.id = "RouteStopItem"."routeStopId"
          and rt."shiftId" = any (select unnest(public.my_shift_ids()))));


-- ---------------------------------------------------------------------------
-- Deliveries: the rider records what he actually dropped off
-- ---------------------------------------------------------------------------

drop policy if exists rider_delivery_select on "DeliveryEntry";
create policy rider_delivery_select on "DeliveryEntry" for select to authenticated
using ("riderId" = any (select unnest(public.my_rider_ids())));

-- riderId must be the rider's own id, so he cannot write deliveries as someone else
drop policy if exists rider_delivery_insert on "DeliveryEntry";
create policy rider_delivery_insert on "DeliveryEntry" for insert to authenticated
with check ("riderId" = any (select unnest(public.my_rider_ids())));

-- Editing a completed shift re-writes a stop by clearing its own same-day entries and
-- re-inserting. A rider may delete only entries he booked himself, never anyone else's.
drop policy if exists rider_delivery_delete on "DeliveryEntry";
create policy rider_delivery_delete on "DeliveryEntry" for delete to authenticated
using ("riderId" = any (select unnest(public.my_rider_ids())));


-- ---------------------------------------------------------------------------
-- Off-days: a customer on NO_DELIVERY / VACATION must be skipped.
-- Without this the rider drives to houses that are away.
-- ---------------------------------------------------------------------------

drop policy if exists rider_calendar_select on "CustomerCalendarDay";
create policy rider_calendar_select on "CustomerCalendarDay" for select to authenticated
using ("customerId" = any (select unnest(public.my_customer_ids())));


-- ---------------------------------------------------------------------------
-- One-day orders: extra qty / extra stops confirmed for a single date.
-- Read-only for the rider — the web owns the CONFIRMED -> SCHEDULED lifecycle.
-- ---------------------------------------------------------------------------

drop policy if exists rider_order_select on "CustomerOrder";
create policy rider_order_select on "CustomerOrder" for select to authenticated
using ("customerId" = any (select unnest(public.my_customer_ids())));

drop policy if exists rider_orderitem_select on "CustomerOrderItem";
create policy rider_orderitem_select on "CustomerOrderItem" for select to authenticated
using ("orderId" = any (select unnest(public.my_order_ids())));


-- ---------------------------------------------------------------------------
-- Free samples: assigned to a shift, shown to the rider as extra stops.
-- (SampleItem has RLS disabled, so it needs no policy.)
-- ---------------------------------------------------------------------------

drop policy if exists rider_sample_select on "SampleLead";
create policy rider_sample_select on "SampleLead" for select to authenticated
using ("shiftId" = any (select unnest(public.my_shift_ids())));

-- The rider reports each sample's outcome from the app: delivered or not (and
-- why not), and how the customer paid. Only these columns, only on samples of
-- the rider's own shifts. The office turns the report into a status — delivered
-- (with the payment booked) or not delivered — when the run is completed.
drop policy if exists rider_sample_update on "SampleLead";
create policy rider_sample_update on "SampleLead" for update to authenticated
using ("shiftId" = any (select unnest(public.my_shift_ids())))
with check ("shiftId" = any (select unnest(public.my_shift_ids())));

grant update ("riderOutcome", "riderOutcomeAt", "notDeliveredReason", "paymentMethod", "updatedAt")
  on "SampleLead" to authenticated;


-- ---------------------------------------------------------------------------
-- Invoices: so the rider can see what a customer owes when collecting cash.
-- Read-only.
-- ---------------------------------------------------------------------------

drop policy if exists rider_invoice_select on "Invoice";
create policy rider_invoice_select on "Invoice" for select to authenticated
using ("customerId" = any (select unnest(public.my_customer_ids())));

drop policy if exists rider_invoiceline_select on "InvoiceLine";
create policy rider_invoiceline_select on "InvoiceLine" for select to authenticated
using ("invoiceId" = any (select unnest(public.my_invoice_ids())));


-- ---------------------------------------------------------------------------
-- Identity, shift and money tables
-- ---------------------------------------------------------------------------
-- These eight tables had RLS OFF and were reachable only through a blanket
-- table grant to `authenticated`. That grant was revoked on the server, which
-- took the app down at the login screen: sign-in succeeded, the very next read
-- of "User" returned 42501, and the rider saw a generic failure.
--
-- Restoring the blanket grant would hand every logged-in customer the whole
-- staff, rider and payment tables, so ownership is expressed as policy instead,
-- with column-level grants where a table holds data a rider must never read
-- ("User".passwordHash, "Employee".baseSalary/dailyWage).

create or replace function public.my_user_id()
returns text language sql stable security definer set search_path = public as $$
  select id from "User" where "supabaseId" = (auth.uid())::text limit 1
$$;

create or replace function public.is_rider()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from "Rider" r
    join "User" u on u.id = r."userId"
    where u."supabaseId" = (auth.uid())::text and r.active and u.active
  )
$$;

grant execute on function public.my_user_id() to authenticated;
grant execute on function public.is_rider()   to authenticated;

alter table "User"              enable row level security;
alter table "Rider"             enable row level security;
alter table "Shift"             enable row level security;
alter table "Route"             enable row level security;
alter table "Payment"           enable row level security;
alter table "RiderExtraItem"    enable row level security;
alter table "InventoryMovement" enable row level security;
alter table "Employee"          enable row level security;

-- User: his own row, plus the managers he is allowed to hand cash to.
drop policy if exists rider_user_self_select on "User";
create policy rider_user_self_select on "User" for select to authenticated
  using ("supabaseId" = (auth.uid())::text);

drop policy if exists rider_user_manager_select on "User";
create policy rider_user_manager_select on "User" for select to authenticated
  using (role::text = 'MANAGER' and active and public.is_rider());

grant select (id, name, phone, role, active, "supabaseId") on "User" to authenticated;

-- Rider: matched through User, not my_rider_ids(), so a DEACTIVATED rider can
-- still read his own row. Without that the app cannot tell "no longer a rider"
-- from "deactivated" and shows the wrong reason on the login screen.
drop policy if exists rider_rider_self_select on "Rider";
create policy rider_rider_self_select on "Rider" for select to authenticated
  using ("userId" = (select public.my_user_id()));

grant select (id, "userId", vehicle, active) on "Rider" to authenticated;

drop policy if exists rider_shift_select on "Shift";
create policy rider_shift_select on "Shift" for select to authenticated
  using (id = any (select unnest(public.my_shift_ids())));

grant select (id, name, type, "startTime", "riderId") on "Shift" to authenticated;

drop policy if exists rider_route_select on "Route";
create policy rider_route_select on "Route" for select to authenticated
  using ("shiftId" = any (select unnest(public.my_shift_ids())));

drop policy if exists rider_route_insert on "Route";
create policy rider_route_insert on "Route" for insert to authenticated
  with check ("shiftId" = any (select unnest(public.my_shift_ids())));

drop policy if exists rider_route_update on "Route";
create policy rider_route_update on "Route" for update to authenticated
  using ("shiftId" = any (select unnest(public.my_shift_ids())))
  with check ("shiftId" = any (select unnest(public.my_shift_ids())));

grant select, insert on "Route" to authenticated;
grant update (status, "startedAt", "completedAt") on "Route" to authenticated;

-- Payment: his own collections (riderId, or enteredById for rows written before
-- riderId existed) and anything owed by a customer on his shift.
drop policy if exists rider_payment_select on "Payment";
create policy rider_payment_select on "Payment" for select to authenticated
  using (
    "riderId" = any (select unnest(public.my_rider_ids()))
    or "enteredById" = (select public.my_user_id())
    or "customerId" = any (select unnest(public.my_customer_ids()))
  );

drop policy if exists rider_payment_insert on "Payment";
create policy rider_payment_insert on "Payment" for insert to authenticated
  with check (
    head::text = 'RIDER_CASH'
    and "customerId" = any (select unnest(public.my_customer_ids()))
    and "riderId" = any (select unnest(public.my_rider_ids()))
  );

-- Cash that has left his hands is settled: once handedOverAt or receivedAt is
-- set the row is out of reach, so a rider can neither rewrite nor delete money
-- a manager has already accepted.
drop policy if exists rider_payment_update on "Payment";
create policy rider_payment_update on "Payment" for update to authenticated
  using (
    head::text = 'RIDER_CASH' and "handedOverAt" is null and "receivedAt" is null
    and ("riderId" = any (select unnest(public.my_rider_ids()))
         or "enteredById" = (select public.my_user_id()))
  )
  with check (head::text = 'RIDER_CASH');

drop policy if exists rider_payment_delete on "Payment";
create policy rider_payment_delete on "Payment" for delete to authenticated
  using (
    head::text = 'RIDER_CASH' and "handedOverAt" is null and "receivedAt" is null
    and ("riderId" = any (select unnest(public.my_rider_ids()))
         or "enteredById" = (select public.my_user_id()))
  );

grant select, insert, delete on "Payment" to authenticated;
grant update ("handedOverAt", "handedToName") on "Payment" to authenticated;

drop policy if exists rider_extra_select on "RiderExtraItem";
create policy rider_extra_select on "RiderExtraItem" for select to authenticated
  using ("shiftId" = any (select unnest(public.my_shift_ids()))
         or "riderId" = any (select unnest(public.my_rider_ids())));

drop policy if exists rider_extra_update on "RiderExtraItem";
create policy rider_extra_update on "RiderExtraItem" for update to authenticated
  using ("shiftId" = any (select unnest(public.my_shift_ids()))
         or "riderId" = any (select unnest(public.my_rider_ids())))
  with check ("shiftId" = any (select unnest(public.my_shift_ids()))
         or "riderId" = any (select unnest(public.my_rider_ids())));

grant select on "RiderExtraItem" to authenticated;
grant update ("returnedQty", "updatedAt") on "RiderExtraItem" to authenticated;

-- InventoryMovement: his own rows, plus anything stamped with one of his routes
-- (the load-confirm read looks up HANDED_OVER by reference = Route.id).
drop policy if exists rider_movement_select on "InventoryMovement";
create policy rider_movement_select on "InventoryMovement" for select to authenticated
  using ("riderId" = any (select unnest(public.my_rider_ids()))
         or reference = any (select unnest(public.my_route_ids())));

drop policy if exists rider_movement_insert on "InventoryMovement";
create policy rider_movement_insert on "InventoryMovement" for insert to authenticated
  with check ("riderId" = any (select unnest(public.my_rider_ids()))
              and type::text in ('WASTAGE', 'RETURNED', 'HANDED_OVER'));

grant select, insert on "InventoryMovement" to authenticated;

-- Correcting his own return after editing a finished shift. When an edit moves milk between
-- "delivered" and "brought back", the end-of-shift return has to move with it, or the office
-- sees milk that both reached a customer and came home. Only his own route-tagged return, only
-- the quantity, and only until a manager has reviewed that day — after that it is the office's.
create or replace function public.rider_return_open(rider text, at timestamp)
returns boolean language sql stable security definer set search_path = public as $$
  select not exists (
    select 1 from "RiderReturnReview" r
     where r."riderId" = rider
       and (r.date + interval '5 hours')::date = (at + interval '5 hours')::date
  );
$$;
grant execute on function public.rider_return_open(text, timestamp) to authenticated;

drop policy if exists rider_return_update on "InventoryMovement";
create policy rider_return_update on "InventoryMovement" for update to authenticated
  using (type::text = 'RETURNED' and reason = 'End of shift return'
         and "riderId" = any (select unnest(public.my_rider_ids()))
         and reference = any (select unnest(public.my_route_ids()))
         and public.rider_return_open("riderId", date))
  with check (type::text = 'RETURNED' and reason = 'End of shift return'
         and "riderId" = any (select unnest(public.my_rider_ids()))
         and reference = any (select unnest(public.my_route_ids())));

grant update (quantity) on "InventoryMovement" to authenticated;

-- Employee: name and role only. Salary columns are withheld at the grant.
drop policy if exists rider_employee_select on "Employee";
create policy rider_employee_select on "Employee" for select to authenticated
  using (active and public.is_rider());

grant select (id, name, role, active) on "Employee" to authenticated;

-- SampleItem was missed by the sweep above: "SampleLead" itself had a policy and a grant, but
-- the lines hanging off it did not, so the route's sample lookup — which embeds SampleItem —
-- returned 403 as a whole. It is wrapped in runCatching, so the failure was silent and the
-- sample stops simply vanished from the rider's route with nothing shown on screen.
alter table "SampleItem" enable row level security;

drop policy if exists rider_sampleitem_select on "SampleItem";
create policy rider_sampleitem_select on "SampleItem" for select to authenticated
  using ("sampleId" = any (select unnest(public.my_sample_ids())));

grant select on "SampleItem" to authenticated;


-- ---------------------------------------------------------------------------
-- Indexes the policies and the app's own reads depend on
-- ---------------------------------------------------------------------------
-- Without these the join columns are sequentially scanned, which the RLS predicates then
-- pay for again on every evaluation.
create index if not exists "RouteStopItem_routeStopId_idx" on "RouteStopItem" ("routeStopId");
create index if not exists "InvoiceLine_invoiceId_idx"     on "InvoiceLine" ("invoiceId");
create index if not exists "SampleItem_sampleId_idx"       on "SampleItem" ("sampleId");
create index if not exists "CustomerOrderItem_orderId_idx" on "CustomerOrderItem" ("orderId");
create index if not exists "Shift_riderId_idx"             on "Shift" ("riderId");
create index if not exists "DeliveryEntry_riderId_idx"     on "DeliveryEntry" ("riderId");
create index if not exists "InventoryMovement_riderId_idx" on "InventoryMovement" ("riderId");
create index if not exists "RiderExtraItem_riderId_idx"    on "RiderExtraItem" ("riderId");


-- ---------------------------------------------------------------------------
-- Live location (Realtime broadcast, no table)
-- ---------------------------------------------------------------------------
-- While a round runs the rider app broadcasts the rider's position every few
-- seconds on a PRIVATE channel, `rider-location:<riderId>`. Private channels are
-- checked against realtime.messages: without these two rules nobody can join.
-- A rider may send on, and listen to, his own channel only; the app's public
-- key alone gets nothing. The web panel listens with the service role, which
-- these rules do not restrict.
--
-- Payload (event "location"): riderId, routeId, shiftId, lat, lng, accuracy (m),
-- speed (m/s, optional), bearing (deg, optional), at (UTC ISO time of the fix).

drop policy if exists rider_location_send on realtime.messages;
create policy rider_location_send on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and substr(realtime.topic(), 1, 15) = 'rider-location:'
    and substr(realtime.topic(), 16) = any(public.my_rider_ids())
  );

drop policy if exists rider_location_listen on realtime.messages;
create policy rider_location_listen on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and substr(realtime.topic(), 1, 15) = 'rider-location:'
    and substr(realtime.topic(), 16) = any(public.my_rider_ids())
  );

-- The office listens too. An admin or manager signed in to the web panel joins
-- every rider's channel with their own login, so the browser can draw the live
-- map without the service key ever leaving the server. Riders and customers are
-- not office users and get nothing more from this rule.
create or replace function public.is_office()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from "User" u
    where u."supabaseId" = (auth.uid())::text and u.active and u.role::text in ('ADMIN', 'MANAGER')
  )
$$;
grant execute on function public.is_office() to authenticated;

drop policy if exists office_location_listen on realtime.messages;
create policy office_location_listen on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and substr(realtime.topic(), 1, 15) = 'rider-location:'
    and public.is_office()
  );

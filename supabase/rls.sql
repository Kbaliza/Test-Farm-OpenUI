-- ============================================================================
-- Row-Level Security for the customer-facing app (Supabase)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase SQL editor AFTER `prisma db push` has created the
-- columns/tables. Re-runnable: every policy is dropped-if-exists first.
--
-- Model:
--   * The ADMIN app connects as the `postgres` pooler role (table owner) and
--     BYPASSES these policies (we ENABLE, never FORCE, RLS) — so nothing here
--     affects the admin app.
--   * The CUSTOMER app connects via supabase-js as the `authenticated` role and
--     is fully governed by these policies. A customer only ever sees/edits rows
--     tied to their own Customer row, matched by  "supabaseId" = auth.uid().
--   * auth.uid() is a uuid; our supabaseId columns are text, so we compare with
--     auth.uid()::text.
--
-- App resolution rule (implement in the customer app):
--   resolve auth.uid() -> a Customer first; a SampleLead only counts while its
--   status <> 'CONVERTED'.
-- ============================================================================

-- Roles need table privileges for RLS to apply within them. (RLS narrows what a
-- granted role can see; without a grant the role sees nothing.)
grant usage on schema public to authenticated;

-- ---------------------------------------------------------------------------
-- PHASE 1 — identity, profile, and read access to a customer's own records
-- ---------------------------------------------------------------------------

-- Customer: read + update own row (profile edit). No insert/delete from the app.
alter table "Customer" enable row level security;
grant select, update on "Customer" to authenticated;
drop policy if exists customer_self_select on "Customer";
create policy customer_self_select on "Customer"
  for select to authenticated
  using ("supabaseId" = auth.uid()::text);
drop policy if exists customer_self_update on "Customer";
create policy customer_self_update on "Customer"
  for update to authenticated
  using ("supabaseId" = auth.uid()::text)
  with check ("supabaseId" = auth.uid()::text);

-- SampleLead: a self-signed-up lead can read/update its own row (until converted)
-- and can INSERT itself on signup.
alter table "SampleLead" enable row level security;
grant select, insert, update on "SampleLead" to authenticated;
drop policy if exists lead_self_select on "SampleLead";
create policy lead_self_select on "SampleLead"
  for select to authenticated
  using ("supabaseId" = auth.uid()::text and status <> 'CONVERTED');
drop policy if exists lead_self_insert on "SampleLead";
create policy lead_self_insert on "SampleLead"
  for insert to authenticated
  with check ("supabaseId" = auth.uid()::text);
drop policy if exists lead_self_update on "SampleLead";
create policy lead_self_update on "SampleLead"
  for update to authenticated
  using ("supabaseId" = auth.uid()::text and status <> 'CONVERTED')
  with check ("supabaseId" = auth.uid()::text);

-- Helper predicate reused below:
--   "customerId" IN (SELECT id FROM "Customer" WHERE "supabaseId" = auth.uid()::text)

-- Invoice (read own)
alter table "Invoice" enable row level security;
grant select on "Invoice" to authenticated;
drop policy if exists invoice_self_select on "Invoice";
create policy invoice_self_select on "Invoice"
  for select to authenticated
  using ("customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text));

-- InvoiceLine (read own, via its Invoice)
alter table "InvoiceLine" enable row level security;
grant select on "InvoiceLine" to authenticated;
drop policy if exists invoiceline_self_select on "InvoiceLine";
create policy invoiceline_self_select on "InvoiceLine"
  for select to authenticated
  using ("invoiceId" in (
    select id from "Invoice"
    where "customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text)
  ));

-- LedgerEntry (read own customer ledger)
alter table "LedgerEntry" enable row level security;
grant select on "LedgerEntry" to authenticated;
drop policy if exists ledger_self_select on "LedgerEntry";
create policy ledger_self_select on "LedgerEntry"
  for select to authenticated
  using ("customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text));

-- DeliveryEntry (read own)
alter table "DeliveryEntry" enable row level security;
grant select on "DeliveryEntry" to authenticated;
drop policy if exists delivery_self_select on "DeliveryEntry";
create policy delivery_self_select on "DeliveryEntry"
  for select to authenticated
  using ("customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text));

-- CustomerProduct (read own subscriptions; permanent changes are admin-only)
alter table "CustomerProduct" enable row level security;
grant select on "CustomerProduct" to authenticated;
drop policy if exists custprod_self_select on "CustomerProduct";
create policy custprod_self_select on "CustomerProduct"
  for select to authenticated
  using ("customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text));

-- RouteStop (read own upcoming/past stops)
alter table "RouteStop" enable row level security;
grant select on "RouteStop" to authenticated;
drop policy if exists routestop_self_select on "RouteStop";
create policy routestop_self_select on "RouteStop"
  for select to authenticated
  using ("customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text));

-- RouteStopItem (read own, via its RouteStop)
alter table "RouteStopItem" enable row level security;
grant select on "RouteStopItem" to authenticated;
drop policy if exists routestopitem_self_select on "RouteStopItem";
create policy routestopitem_self_select on "RouteStopItem"
  for select to authenticated
  using ("routeStopId" in (
    select id from "RouteStop"
    where "customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text)
  ));

-- Product / Area: catalogue readable by any authenticated user.
alter table "Product" enable row level security;
grant select on "Product" to authenticated;
drop policy if exists product_read_all on "Product";
create policy product_read_all on "Product" for select to authenticated using (true);

alter table "Area" enable row level security;
grant select on "Area" to authenticated;
drop policy if exists area_read_all on "Area";
create policy area_read_all on "Area" for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- PHASE 2 — one-day / shop orders (customer places + reads own)
-- ---------------------------------------------------------------------------
alter table "CustomerOrder" enable row level security;
grant select, insert on "CustomerOrder" to authenticated;
drop policy if exists order_self_select on "CustomerOrder";
create policy order_self_select on "CustomerOrder"
  for select to authenticated
  using ("customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text));
drop policy if exists order_self_insert on "CustomerOrder";
create policy order_self_insert on "CustomerOrder"
  for insert to authenticated
  with check ("customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text));

alter table "CustomerOrderItem" enable row level security;
grant select, insert on "CustomerOrderItem" to authenticated;
drop policy if exists orderitem_self_select on "CustomerOrderItem";
create policy orderitem_self_select on "CustomerOrderItem"
  for select to authenticated
  using ("orderId" in (
    select id from "CustomerOrder"
    where "customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text)
  ));
drop policy if exists orderitem_self_insert on "CustomerOrderItem";
create policy orderitem_self_insert on "CustomerOrderItem"
  for insert to authenticated
  with check ("orderId" in (
    select id from "CustomerOrder"
    where "customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text)
  ));

-- ---------------------------------------------------------------------------
-- PHASE 3 — calendar, notifications, payment proof
-- ---------------------------------------------------------------------------

-- CustomerCalendarDay: customer sets/reads own off-days.
alter table "CustomerCalendarDay" enable row level security;
grant select, insert, update, delete on "CustomerCalendarDay" to authenticated;
drop policy if exists calendar_self_all on "CustomerCalendarDay";
create policy calendar_self_all on "CustomerCalendarDay"
  for all to authenticated
  using ("customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text))
  with check ("customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text));

-- CustomerNotification: read own + mark read (update readAt). Creation is admin/system-side.
alter table "CustomerNotification" enable row level security;
grant select, update on "CustomerNotification" to authenticated;
drop policy if exists notif_self_select on "CustomerNotification";
create policy notif_self_select on "CustomerNotification"
  for select to authenticated
  using ("customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text));
drop policy if exists notif_self_update on "CustomerNotification";
create policy notif_self_update on "CustomerNotification"
  for update to authenticated
  using ("customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text))
  with check ("customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text));

-- PaymentProof: customer submits + reads own; review/approval is admin-only.
alter table "PaymentProof" enable row level security;
grant select, insert on "PaymentProof" to authenticated;
drop policy if exists proof_self_select on "PaymentProof";
create policy proof_self_select on "PaymentProof"
  for select to authenticated
  using ("customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text));
drop policy if exists proof_self_insert on "PaymentProof";
create policy proof_self_insert on "PaymentProof"
  for insert to authenticated
  with check ("customerId" in (select id from "Customer" where "supabaseId" = auth.uid()::text));

-- Storage-bucket policies live in supabase/storage-policies.sql (they target
-- storage.objects, which is owned by Supabase's storage admin — run separately,
-- or add them via Dashboard → Storage → Policies if raw SQL is rejected).

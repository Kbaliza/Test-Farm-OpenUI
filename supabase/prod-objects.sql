-- ============================================================================
-- Database objects extracted from the live production database on 2026-08-09.
--
-- WHY THIS FILE EXISTS
--   Everything below was built directly against the Supabase project — most of
--   it by whoever built the rider mobile app — and existed in no source file.
--   It was found only because migrating to a new project diffed the two
--   databases: 16 functions, 4 triggers and 23 RLS policies were about to be
--   silently left behind, which would have broken the rider app completely.
--
--   Treat this file as the source of truth from now on. If you change a policy
--   or function in the Supabase SQL editor, change it here too.
--
-- SCOPE
--   * pg_net extension (the push trigger makes outbound HTTP calls)
--   * 17 functions — the my_*_ids() helpers the rider RLS policies depend on,
--     the customer push/notification chain, and the vault get/set helpers
--   * 4 triggers — invoice created, push on notification, route started,
--     stop delivered
--   * 46 RLS policies + the 17 tables they are enabled on. This SUPERSEDES
--     rls.sql, which only ever covered the 23 customer-app policies.
--
-- RUNNING IT
--   Idempotent — every object is CREATE OR REPLACE or DROP-IF-EXISTS first.
--   `SET check_function_bodies = off` is required: the functions reference each
--   other, and they are created in alphabetical order, so bodies cannot be
--   validated as they are created.
--
--     psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f supabase/prod-objects.sql
--
-- NOT COVERED — still outside version control
--   * The `send-push` Edge Function that trg_push_notification calls. Its
--     source lives only in the Supabase project. Pull it with
--     `supabase functions download send-push` and commit it.
--   * The vault secrets it reads (`firebase_sa`, `service_key`). Secrets, so
--     they stay out of git — but note `service_key` is PROJECT-SPECIFIC and
--     must be re-set when the project changes.
--
-- PROJECT-SPECIFIC VALUE BELOW
--   trg_push_notification hardcodes the project's edge-function URL. It is set
--   to the current project. Update it if the project ref ever changes again.
-- ============================================================================

SET check_function_bodies = off;

-- Extracted from the production database on 2026-08-09.
-- These objects existed ONLY in the live database and in no source file.

CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- ---------- functions ----------
CREATE OR REPLACE FUNCTION public.customer_eta()
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_customer_id text;
  v_route_id    text;
  v_route_status text;
  v_my_stop     int;
  v_my_status   text;
  v_delivered_at timestamp;
  v_ahead       int;
  v_pace        numeric;
  v_legs        int;
  v_eta         int;
  v_seed        constant numeric := 7;
  v_min_legs    constant int     := 8;
  v_today       date := (now() at time zone 'Asia/Karachi')::date;
begin
  select id into v_customer_id
  from "Customer"
  where "supabaseId" = auth.uid()::text;

  if v_customer_id is null then
    return json_build_object('state', 'none');
  end if;

  select rs."routeId", rs."stopNumber", rs.status, rs."deliveredAt", r.status::text
    into v_route_id, v_my_stop, v_my_status, v_delivered_at, v_route_status
  from "RouteStop" rs
  join "Route" r on r.id = rs."routeId"
  where rs."customerId" = v_customer_id
    and r.date >= v_today
    and r.date <  v_today + 1
  order by rs."stopNumber"
  limit 1;

  if v_route_id is null then
    return json_build_object('state', 'no_delivery');
  end if;

  if v_my_status = 'DELIVERED' then
    return json_build_object('state', 'delivered', 'deliveredAt', v_delivered_at);
  end if;

  if v_my_status = 'SKIPPED' then
    return json_build_object('state', 'skipped');
  end if;

  with ordered as (
    select rs."routeId",
           rs."stopNumber",
           rs."deliveredAt",
           lag(rs."deliveredAt") over (partition by rs."routeId" order by rs."stopNumber") as prev_at,
           lag(rs."stopNumber")  over (partition by rs."routeId" order by rs."stopNumber") as prev_no
    from "RouteStop" rs
    where rs."deliveredAt" is not null
  ),
  legs as (
    select extract(epoch from ("deliveredAt" - prev_at)) / 60.0
             / nullif("stopNumber" - prev_no, 0) as min_per_stop
    from ordered
    where prev_at is not null
  ),
  clean as (
    select min_per_stop from legs
    where min_per_stop >= 1 and min_per_stop <= 45
  )
  select count(*), percentile_cont(0.5) within group (order by min_per_stop)
    into v_legs, v_pace
  from clean;

  if v_legs < v_min_legs or v_pace is null then
    v_pace := v_seed;
  end if;

  select count(*) into v_ahead
  from "RouteStop"
  where "routeId" = v_route_id
    and "stopNumber" < v_my_stop
    and status = 'PENDING';

  v_eta := ceil((v_ahead + 1) * v_pace);

  return json_build_object(
    'state', case when v_route_status = 'IN_PROGRESS' then 'on_way' else 'scheduled' end,
    'stopsAway', v_ahead,
    'etaMinutes', v_eta,
    'paceMinutes', round(v_pace, 1)
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_secret(p_name text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
declare
  v text;
begin
  select decrypted_secret into v from vault.decrypted_secrets where name = p_name;
  return v;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.my_customer_ids()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(cid), '{}'::text[]) from (
    -- customers on the rider's shifts (the real membership key the web uses)
    select c.id as cid from "Customer" c where c."shiftId" = any(public.my_shift_ids())
    union
    select c.id from "Customer" c where c."riderId" = any(public.my_rider_ids())
    union
    select rs."customerId" from "RouteStop" rs where rs.id = any(public.my_routestop_ids())
  ) x
$function$
;

CREATE OR REPLACE FUNCTION public.my_invoice_ids()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(i.id), '{}'::text[])
  from "Invoice" i
  where i."customerId" = any(public.my_customer_ids())
$function$
;

CREATE OR REPLACE FUNCTION public.my_order_ids()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(o.id), '{}'::text[])
  from "CustomerOrder" o
  where o."customerId" = any(public.my_customer_ids())
$function$
;

CREATE OR REPLACE FUNCTION public.my_rider_ids()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(r.id), '{}'::text[])
  from "Rider" r
  join "User" u on u.id = r."userId"
  where u."supabaseId" = (auth.uid())::text
    and r.active and u.active
$function$
;

CREATE OR REPLACE FUNCTION public.my_route_ids()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(r.id), '{}'::text[])
  from "Route" r
  where r."shiftId" = any(public.my_shift_ids())
$function$
;

CREATE OR REPLACE FUNCTION public.my_routestop_ids()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(rs.id), '{}'::text[])
  from "RouteStop" rs
  join "Route" rt on rt.id = rs."routeId"
  where rt."shiftId" = any(public.my_shift_ids())
     or rs."riderId"  = any(public.my_rider_ids())
$function$
;

CREATE OR REPLACE FUNCTION public.my_sample_ids()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(sl.id), '{}'::text[])
  from "SampleLead" sl
  where sl."shiftId" = any(public.my_shift_ids())
$function$
;

CREATE OR REPLACE FUNCTION public.my_shift_ids()
 RETURNS text[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(array_agg(s.id), '{}'::text[])
  from "Shift" s
  where s."riderId" = any(public.my_rider_ids())
$function$
;

CREATE OR REPLACE FUNCTION public.notify_customer(p_customer_id text, p_type text, p_title text, p_body text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into "CustomerNotification" (id, "customerId", type, title, body)
  values (gen_random_uuid()::text, p_customer_id, p_type, p_title, p_body);
exception when others then
  null;  -- never let a notification break the write that caused it
end;
$function$
;

CREATE OR REPLACE FUNCTION public.push_tokens_for(p_customer_id text)
 RETURNS SETOF text
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select token from "DeviceToken" where "customerId" = p_customer_id;
$function$
;

REVOKE ALL ON FUNCTION public.push_tokens_for(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.push_tokens_for(text) TO service_role;

CREATE OR REPLACE FUNCTION public.set_secret(p_name text, p_value text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'vault'
AS $function$
declare
  v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then
    perform vault.create_secret(p_value, p_name, 'set via set_secret');
  else
    perform vault.update_secret(v_id, p_value, p_name, 'updated via set_secret');
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.sync_delivery_return_to_movement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  ref_id text;
begin
  if (TG_OP = 'DELETE') then
    ref_id := OLD.id;
  else
    ref_id := NEW.id;
  end if;

  if (TG_OP = 'UPDATE' or TG_OP = 'DELETE') then
    delete from "InventoryMovement"
     where reference = ref_id
       and type = 'RETURNED'
       and reason = 'Rider return';
  end if;

  if (TG_OP <> 'DELETE') then
    if NEW."isReturn" = true and NEW."isReplacement" = false then
      insert into "InventoryMovement"
        (id, date, type, "productId", quantity, "riderId", reason, reference, "createdAt")
      values
        (gen_random_uuid()::text, NEW.date, 'RETURNED', NEW."productId", NEW.quantity, NEW."riderId",
         'Rider return', NEW.id, now());
    end if;
  end if;

  if (TG_OP = 'DELETE') then
    return OLD;
  end if;
  return NEW;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_invoice_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  begin
    perform public.notify_customer(
      new."customerId",
      'BILL',
      'New bill ready',
      'Your bill for this cycle is ready to view.'
    );
  exception when others then
    null;
  end;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_push_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_key text;
begin
  begin
    select public.get_secret('service_key') into v_key;
    if v_key is null then
      return new;
    end if;

    perform net.http_post(
      url := 'https://alrahkhcxfulircvsocw.supabase.co/functions/v1/send-push',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_key
      ),
      body := jsonb_build_object(
        'customerId', new."customerId",
        'title', new.title,
        'body', new.body,
        'type', new.type
      )
    );
  exception when others then
    null;  -- a push that cannot be queued must never fail the insert
  end;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_route_started()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status::text = 'IN_PROGRESS' and coalesce(old.status::text, '') <> 'IN_PROGRESS' then
    begin
      perform public.notify_customer(
        rs."customerId",
        'ON_THE_WAY',
        'Rider is on the way',
        'Your rider has set off. Track your delivery in the app.'
      )
      from "RouteStop" rs
      where rs."routeId" = new.id and rs.status = 'PENDING';
    exception when others then
      null;
    end;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.trg_stop_delivered()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.status = 'DELIVERED' and coalesce(old.status, '') <> 'DELIVERED' then
    begin
      perform public.notify_customer(
        new."customerId",
        'DELIVERED',
        'Delivered',
        'Your order has been delivered. Thank you!'
      );
    exception when others then
      null;
    end;
  end if;
  return new;
end;
$function$
;

-- ---------- triggers ----------
DROP TRIGGER IF EXISTS invoice_created_notify ON "Invoice";
CREATE TRIGGER invoice_created_notify AFTER INSERT ON public."Invoice" FOR EACH ROW EXECUTE FUNCTION trg_invoice_created();

DROP TRIGGER IF EXISTS push_on_notification ON "CustomerNotification";
CREATE TRIGGER push_on_notification AFTER INSERT ON public."CustomerNotification" FOR EACH ROW EXECUTE FUNCTION trg_push_notification();

DROP TRIGGER IF EXISTS route_started_notify ON "Route";
CREATE TRIGGER route_started_notify AFTER UPDATE OF status ON public."Route" FOR EACH ROW EXECUTE FUNCTION trg_route_started();

DROP TRIGGER IF EXISTS stop_delivered_notify ON "RouteStop";
CREATE TRIGGER stop_delivered_notify AFTER UPDATE OF status ON public."RouteStop" FOR EACH ROW EXECUTE FUNCTION trg_stop_delivered();

-- ---------- row level security ----------
ALTER TABLE public."Area" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Customer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CustomerCalendarDay" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CustomerNotification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CustomerOrder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CustomerOrderItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."CustomerProduct" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DeliveryEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."DeviceToken" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Invoice" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."InvoiceLine" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."LedgerEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."PaymentProof" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."Product" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."RouteStop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."RouteStopItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE public."SampleLead" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS area_read_all ON public."Area";
CREATE POLICY area_read_all ON public."Area" AS PERMISSIVE FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS area_read_public ON public."Area";
CREATE POLICY area_read_public ON public."Area" AS PERMISSIVE FOR SELECT TO anon USING (true);

-- A policy alone is not enough: without this GRANT the anon role cannot read
-- Area at all, and the signup area picker fails before anyone can log in. The
-- grant was lost in the project move and had to be re-applied on 2026-09-08.
GRANT SELECT ON public."Area" TO anon;
DROP POLICY IF EXISTS customer_self_select ON public."Customer";
CREATE POLICY customer_self_select ON public."Customer" AS PERMISSIVE FOR SELECT TO authenticated USING (("supabaseId" = (auth.uid())::text));
DROP POLICY IF EXISTS customer_self_update ON public."Customer";
CREATE POLICY customer_self_update ON public."Customer" AS PERMISSIVE FOR UPDATE TO authenticated USING (("supabaseId" = (auth.uid())::text)) WITH CHECK (("supabaseId" = (auth.uid())::text));
DROP POLICY IF EXISTS rider_customer_select ON public."Customer";
CREATE POLICY rider_customer_select ON public."Customer" AS PERMISSIVE FOR SELECT TO authenticated USING ((id = ANY (my_customer_ids())));
DROP POLICY IF EXISTS calendar_self_all ON public."CustomerCalendarDay";
CREATE POLICY calendar_self_all ON public."CustomerCalendarDay" AS PERMISSIVE FOR ALL TO authenticated USING (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text)))) WITH CHECK (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS rider_calendar_select ON public."CustomerCalendarDay";
CREATE POLICY rider_calendar_select ON public."CustomerCalendarDay" AS PERMISSIVE FOR SELECT TO authenticated USING (("customerId" = ANY (my_customer_ids())));
DROP POLICY IF EXISTS notif_self_delete ON public."CustomerNotification";
CREATE POLICY notif_self_delete ON public."CustomerNotification" AS PERMISSIVE FOR DELETE TO authenticated USING (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS notif_self_select ON public."CustomerNotification";
CREATE POLICY notif_self_select ON public."CustomerNotification" AS PERMISSIVE FOR SELECT TO authenticated USING (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS notif_self_update ON public."CustomerNotification";
CREATE POLICY notif_self_update ON public."CustomerNotification" AS PERMISSIVE FOR UPDATE TO authenticated USING (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text)))) WITH CHECK (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS order_self_insert ON public."CustomerOrder";
CREATE POLICY order_self_insert ON public."CustomerOrder" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS order_self_select ON public."CustomerOrder";
CREATE POLICY order_self_select ON public."CustomerOrder" AS PERMISSIVE FOR SELECT TO authenticated USING (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS rider_order_select ON public."CustomerOrder";
CREATE POLICY rider_order_select ON public."CustomerOrder" AS PERMISSIVE FOR SELECT TO authenticated USING (("customerId" = ANY (my_customer_ids())));
DROP POLICY IF EXISTS orderitem_self_insert ON public."CustomerOrderItem";
CREATE POLICY orderitem_self_insert ON public."CustomerOrderItem" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (("orderId" IN ( SELECT "CustomerOrder".id
   FROM "CustomerOrder"
  WHERE ("CustomerOrder"."customerId" IN ( SELECT "Customer".id
           FROM "Customer"
          WHERE ("Customer"."supabaseId" = (auth.uid())::text))))));
DROP POLICY IF EXISTS orderitem_self_select ON public."CustomerOrderItem";
CREATE POLICY orderitem_self_select ON public."CustomerOrderItem" AS PERMISSIVE FOR SELECT TO authenticated USING (("orderId" IN ( SELECT "CustomerOrder".id
   FROM "CustomerOrder"
  WHERE ("CustomerOrder"."customerId" IN ( SELECT "Customer".id
           FROM "Customer"
          WHERE ("Customer"."supabaseId" = (auth.uid())::text))))));
DROP POLICY IF EXISTS rider_orderitem_select ON public."CustomerOrderItem";
CREATE POLICY rider_orderitem_select ON public."CustomerOrderItem" AS PERMISSIVE FOR SELECT TO authenticated USING (("orderId" = ANY (my_order_ids())));
DROP POLICY IF EXISTS custprod_self_select ON public."CustomerProduct";
CREATE POLICY custprod_self_select ON public."CustomerProduct" AS PERMISSIVE FOR SELECT TO authenticated USING (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS rider_custprod_select ON public."CustomerProduct";
CREATE POLICY rider_custprod_select ON public."CustomerProduct" AS PERMISSIVE FOR SELECT TO authenticated USING (("customerId" = ANY (my_customer_ids())));
DROP POLICY IF EXISTS delivery_self_select ON public."DeliveryEntry";
CREATE POLICY delivery_self_select ON public."DeliveryEntry" AS PERMISSIVE FOR SELECT TO authenticated USING (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS rider_delivery_delete ON public."DeliveryEntry";
CREATE POLICY rider_delivery_delete ON public."DeliveryEntry" AS PERMISSIVE FOR DELETE TO authenticated USING (("riderId" = ANY (my_rider_ids())));
DROP POLICY IF EXISTS rider_delivery_insert ON public."DeliveryEntry";
CREATE POLICY rider_delivery_insert ON public."DeliveryEntry" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (("riderId" = ANY (my_rider_ids())));
DROP POLICY IF EXISTS rider_delivery_select ON public."DeliveryEntry";
CREATE POLICY rider_delivery_select ON public."DeliveryEntry" AS PERMISSIVE FOR SELECT TO authenticated USING (("riderId" = ANY (my_rider_ids())));
DROP POLICY IF EXISTS devicetoken_self_delete ON public."DeviceToken";
CREATE POLICY devicetoken_self_delete ON public."DeviceToken" AS PERMISSIVE FOR DELETE TO authenticated USING (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS devicetoken_self_insert ON public."DeviceToken";
CREATE POLICY devicetoken_self_insert ON public."DeviceToken" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS devicetoken_self_select ON public."DeviceToken";
CREATE POLICY devicetoken_self_select ON public."DeviceToken" AS PERMISSIVE FOR SELECT TO authenticated USING (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS devicetoken_self_update ON public."DeviceToken";
CREATE POLICY devicetoken_self_update ON public."DeviceToken" AS PERMISSIVE FOR UPDATE TO authenticated USING (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS invoice_self_select ON public."Invoice";
CREATE POLICY invoice_self_select ON public."Invoice" AS PERMISSIVE FOR SELECT TO authenticated USING (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS rider_invoice_select ON public."Invoice";
CREATE POLICY rider_invoice_select ON public."Invoice" AS PERMISSIVE FOR SELECT TO authenticated USING (("customerId" = ANY (my_customer_ids())));
DROP POLICY IF EXISTS invoiceline_self_select ON public."InvoiceLine";
CREATE POLICY invoiceline_self_select ON public."InvoiceLine" AS PERMISSIVE FOR SELECT TO authenticated USING (("invoiceId" IN ( SELECT "Invoice".id
   FROM "Invoice"
  WHERE ("Invoice"."customerId" IN ( SELECT "Customer".id
           FROM "Customer"
          WHERE ("Customer"."supabaseId" = (auth.uid())::text))))));
DROP POLICY IF EXISTS rider_invoiceline_select ON public."InvoiceLine";
CREATE POLICY rider_invoiceline_select ON public."InvoiceLine" AS PERMISSIVE FOR SELECT TO authenticated USING (("invoiceId" = ANY (my_invoice_ids())));
DROP POLICY IF EXISTS ledger_self_select ON public."LedgerEntry";
CREATE POLICY ledger_self_select ON public."LedgerEntry" AS PERMISSIVE FOR SELECT TO authenticated USING (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS proof_self_insert ON public."PaymentProof";
CREATE POLICY proof_self_insert ON public."PaymentProof" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS proof_self_select ON public."PaymentProof";
CREATE POLICY proof_self_select ON public."PaymentProof" AS PERMISSIVE FOR SELECT TO authenticated USING (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS product_read_all ON public."Product";
CREATE POLICY product_read_all ON public."Product" AS PERMISSIVE FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS rider_routestop_insert ON public."RouteStop";
CREATE POLICY rider_routestop_insert ON public."RouteStop" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (("routeId" = ANY (my_route_ids())));
DROP POLICY IF EXISTS rider_routestop_select ON public."RouteStop";
CREATE POLICY rider_routestop_select ON public."RouteStop" AS PERMISSIVE FOR SELECT TO authenticated USING ((id = ANY (my_routestop_ids())));
DROP POLICY IF EXISTS rider_routestop_update ON public."RouteStop";
CREATE POLICY rider_routestop_update ON public."RouteStop" AS PERMISSIVE FOR UPDATE TO authenticated USING ((id = ANY (my_routestop_ids()))) WITH CHECK ((id = ANY (my_routestop_ids())));
DROP POLICY IF EXISTS routestop_self_select ON public."RouteStop";
CREATE POLICY routestop_self_select ON public."RouteStop" AS PERMISSIVE FOR SELECT TO authenticated USING (("customerId" IN ( SELECT "Customer".id
   FROM "Customer"
  WHERE ("Customer"."supabaseId" = (auth.uid())::text))));
DROP POLICY IF EXISTS rider_rsi_insert ON public."RouteStopItem";
CREATE POLICY rider_rsi_insert ON public."RouteStopItem" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (("routeStopId" = ANY (my_routestop_ids())));
DROP POLICY IF EXISTS rider_rsi_select ON public."RouteStopItem";
CREATE POLICY rider_rsi_select ON public."RouteStopItem" AS PERMISSIVE FOR SELECT TO authenticated USING (("routeStopId" = ANY (my_routestop_ids())));
DROP POLICY IF EXISTS rider_rsi_update ON public."RouteStopItem";
CREATE POLICY rider_rsi_update ON public."RouteStopItem" AS PERMISSIVE FOR UPDATE TO authenticated USING (("routeStopId" = ANY (my_routestop_ids()))) WITH CHECK (("routeStopId" = ANY (my_routestop_ids())));
DROP POLICY IF EXISTS routestopitem_self_select ON public."RouteStopItem";
CREATE POLICY routestopitem_self_select ON public."RouteStopItem" AS PERMISSIVE FOR SELECT TO authenticated USING (("routeStopId" IN ( SELECT "RouteStop".id
   FROM "RouteStop"
  WHERE ("RouteStop"."customerId" IN ( SELECT "Customer".id
           FROM "Customer"
          WHERE ("Customer"."supabaseId" = (auth.uid())::text))))));
DROP POLICY IF EXISTS lead_self_insert ON public."SampleLead";
CREATE POLICY lead_self_insert ON public."SampleLead" AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK (("supabaseId" = (auth.uid())::text));
DROP POLICY IF EXISTS lead_self_select ON public."SampleLead";
CREATE POLICY lead_self_select ON public."SampleLead" AS PERMISSIVE FOR SELECT TO authenticated USING ((("supabaseId" = (auth.uid())::text) AND (status <> 'CONVERTED'::"SampleStatus")));
DROP POLICY IF EXISTS lead_self_update ON public."SampleLead";
CREATE POLICY lead_self_update ON public."SampleLead" AS PERMISSIVE FOR UPDATE TO authenticated USING ((("supabaseId" = (auth.uid())::text) AND (status <> 'CONVERTED'::"SampleStatus"))) WITH CHECK (("supabaseId" = (auth.uid())::text));
DROP POLICY IF EXISTS rider_sample_select ON public."SampleLead";
CREATE POLICY rider_sample_select ON public."SampleLead" AS PERMISSIVE FOR SELECT TO authenticated USING (("shiftId" = ANY (my_shift_ids())));

-- ============================================================================
-- Rider-return sync: DeliveryEntry -> InventoryMovement (run in Supabase SQL
-- editor, or via `npx tsx scripts/apply-returns-sync-trigger.ts` — either
-- runs against DIRECT_URL, same as prisma migrations. Re-runnable: the
-- function/trigger are dropped-if-exists first).
--
-- Why a DB trigger, not application code:
--   The rider mobile app (a separate codebase) writes DeliveryEntry rows
--   directly to Postgres. "isReturn = true" rows are the authoritative record
--   of what a rider actually returned (already used as the source of truth
--   for customer bill credits in billing/invoices/actions.ts). Nothing has
--   ever mirrored that into InventoryMovement, so InventoryMovement's
--   "RETURNED" type — which the Inventory Summary, the per-product/rider
--   "with riders" math, and the Product Ledger all read from — has always
--   been empty. A trigger fires regardless of which app performs the insert,
--   updates in true real time, and keeps InventoryMovement as the single
--   source of truth for all stock movement types (matching how HANDED_OVER,
--   WASTAGE, PRODUCED etc. already work).
--
-- isReplacement rows are skipped (mirrors the `if (de.isReplacement) continue`
-- guard already used when computing delivered/returned quantities elsewhere).
--
-- Complaint refunds are skipped too ("complaintId" is set). A refund is written as
-- an isReturn row so every bill and balance credits it, but the customer poured
-- that milk away — nothing came back. Mirroring it would add phantom stock equal
-- to every litre ever refunded.
--
-- Fires on INSERT **and UPDATE and DELETE**. The rider app doesn't only insert —
-- it corrects. When it only fired on insert, every correction silently desynced
-- stock, with no error and nothing to notice:
--   * correct a return 5 L -> 1 L  ->  movement kept saying 5 L (4 L credited that
--     never came back)
--   * delete the entry          ->  movement survived as a phantom credit
--   * flip isReturn false->true ->  no movement was ever written (milk lost)
-- Each of those was reproduced against this database before this change.
--
-- The mirror is rebuilt rather than patched: on UPDATE/DELETE we drop whatever we
-- previously wrote for that row (keyed on reference = the DeliveryEntry id) and,
-- if the row still qualifies, write it again from the current values. That makes
-- the trigger idempotent and correct for every transition — including
-- isReturn/isReplacement being flipped in either direction.
--
-- The delete is scoped to type='RETURNED' AND reason='Rider return' so it can only
-- ever remove rows THIS trigger created; a hand-entered RETURNED movement that
-- happens to share a reference is left alone.
-- ============================================================================

create extension if not exists pgcrypto;

create or replace function sync_delivery_return_to_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ref_id text;
begin
  if (TG_OP = 'DELETE') then
    ref_id := OLD.id;
  else
    ref_id := NEW.id;
  end if;

  -- Drop the previous mirror for this DeliveryEntry, if any.
  if (TG_OP = 'UPDATE' or TG_OP = 'DELETE') then
    delete from "InventoryMovement"
     where reference = ref_id
       and type = 'RETURNED'
       and reason = 'Rider return';
  end if;

  -- Re-create it from the current row when it still qualifies as a return.
  if (TG_OP <> 'DELETE') then
    if NEW."isReturn" = true and NEW."isReplacement" = false and NEW."complaintId" is null then
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
$$;

drop trigger if exists trg_delivery_return_sync on "DeliveryEntry";
create trigger trg_delivery_return_sync
  after insert or update or delete on "DeliveryEntry"
  for each row
  execute function sync_delivery_return_to_movement();

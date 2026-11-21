-- A shift on the road cannot change rider.
--
-- The website refuses it (src/lib/shift-lock.ts); this is the safety net under
-- it, so no screen — present or future — can hand a loaded round to another rider
-- by accident. A round is "on the road" from the rider's first load confirmation
-- (an InventoryMovement HANDED_OVER row referencing the route) or its start, until
-- it is COMPLETED. The one way through is the admin's deliberate handover, which
-- sets app.shift_handover = 'on' for its transaction.
CREATE OR REPLACE FUNCTION public.shift_rider_lock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  day_start timestamptz := date_trunc('day', now() AT TIME ZONE 'Asia/Karachi') AT TIME ZONE 'Asia/Karachi';
  running "Route"%ROWTYPE;
BEGIN
  IF NEW."riderId" IS NOT DISTINCT FROM OLD."riderId" THEN
    RETURN NEW;
  END IF;
  IF current_setting('app.shift_handover', true) = 'on' THEN
    RETURN NEW;
  END IF;
  SELECT r.* INTO running
    FROM "Route" r
   WHERE r."shiftId" = OLD.id
     AND r.date >= day_start AND r.date < day_start + interval '1 day'
     AND r.status <> 'COMPLETED'
     AND (r.status = 'IN_PROGRESS'
          OR EXISTS (SELECT 1 FROM "InventoryMovement" m WHERE m.type = 'HANDED_OVER' AND m.reference = r.id))
   ORDER BY r."createdAt"
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'This shift is on the road: its round for today has been loaded and is not finished. It can be changed once the round is finished, or an admin can hand the round over.'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shift_rider_lock ON "Shift";
CREATE TRIGGER trg_shift_rider_lock
  BEFORE UPDATE OF "riderId" ON "Shift"
  FOR EACH ROW
  EXECUTE FUNCTION public.shift_rider_lock();

-- The price of a delivery is decided here, never by the rider app.
--
-- From early October the rider app saved every delivery at the product's standard
-- price (cow 260, mix 280, buffalo 350) and ignored the customer's own rate, so 74
-- customers on special rates were billed at the standard price for 1-15 Oct. The
-- bill prices each line from DeliveryEntry."unitRate", so whatever the app saves
-- is what the customer pays.
--
-- Rows written by an app login (auth.uid() set: the rider app over PostgREST) get
-- their rate from our records before they are stored: the customer's own rate for
-- that product, else the product's standard price. Rows written by the website
-- (Prisma, no JWT, so auth.uid() is null) are untouched — a price typed on a bill
-- or a manager's edit stays what the office set. Replacements (free) and complaint
-- refunds keep their own rate.
--
-- SECURITY DEFINER so the lookup is not limited by the rider's row-level access:
-- a customer moved off his shift mid-round must still be priced at their own rate.
CREATE OR REPLACE FUNCTION public.delivery_entry_server_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rate numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."isReplacement" OR NEW."complaintId" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT cp."ratePerUnit" INTO rate
    FROM "CustomerProduct" cp
   WHERE cp."customerId" = NEW."customerId" AND cp."productId" = NEW."productId"
   LIMIT 1;
  IF rate IS NULL THEN
    SELECT p."defaultRate" INTO rate FROM "Product" p WHERE p.id = NEW."productId";
  END IF;
  IF rate IS NOT NULL THEN
    NEW."unitRate" := rate;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_delivery_entry_server_rate ON "DeliveryEntry";
CREATE TRIGGER trg_delivery_entry_server_rate
  BEFORE INSERT ON "DeliveryEntry"
  FOR EACH ROW
  EXECUTE FUNCTION public.delivery_entry_server_rate();

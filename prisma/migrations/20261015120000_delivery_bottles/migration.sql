-- How many of a delivery's litres went out in glass bottles. NULL or 0 = packets.
-- Nullable with no default: adding it rewrites nothing and every existing row
-- reads as packets.
ALTER TABLE "DeliveryEntry" ADD COLUMN "bottles" INTEGER;

-- The day a staff member stopped working here.
--
-- Disabling someone only flipped a flag, so there was no way to know WHEN they
-- left — and a month they worked half of either paid them in full or dropped them
-- from the month entirely. With a date, the month can be split at it.
--
-- Null means either still working, or disabled before this column existed; both
-- are treated as "no known leaving date", which leaves their past months exactly
-- as they were.
ALTER TABLE "Employee" ADD COLUMN "leftAt" TIMESTAMP(3);

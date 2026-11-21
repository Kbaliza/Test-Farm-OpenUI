-- A role for staff whose only job in the software is the daily checklist.
--
-- Purely additive: the value is only ADDED here and never used by this migration,
-- so there is no "unsafe use of new enum value" problem. No existing user row is
-- touched — nobody holds the new role until someone is given it on the Users page.
--
-- Same form already proven on this database by
-- 20260830090000_retail_manager_role and 20260828090000_retail_only_pack_units.
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'CHECKLIST';

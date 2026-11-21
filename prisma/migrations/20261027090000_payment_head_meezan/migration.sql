-- A new account for money to sit in: Meezan Bank, beside HBL. Additive only —
-- no existing row changes, and it starts at zero (no opening balance).
ALTER TYPE "PaymentHead" ADD VALUE IF NOT EXISTS 'MEEZAN' AFTER 'HBL';

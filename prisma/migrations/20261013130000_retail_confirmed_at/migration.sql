-- When Retail accepted (or disputed) a send, for the Flow Log.
ALTER TABLE "RetailDispatch" ADD COLUMN "confirmedAt" TIMESTAMP(3);

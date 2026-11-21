-- ============================================================================
-- Storage RLS for the customer app's buckets (run in Supabase SQL editor).
-- Buckets are created by scripts/ensure-customer-buckets.ts.
-- storage.objects is owned by Supabase's storage admin; if raw SQL is rejected,
-- add these via Dashboard → Storage → Policies instead.
--
-- Convention: customers upload proof screenshots under a folder named after
-- their auth uid:  payment-proofs/<auth.uid()>/<file>
-- ============================================================================

drop policy if exists proof_upload_own on storage.objects;
create policy proof_upload_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'payment-proofs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists proof_read_own on storage.objects;
create policy proof_read_own on storage.objects
  for select to authenticated
  using (bucket_id = 'payment-proofs' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists product_images_read on storage.objects;
create policy product_images_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'product-images');

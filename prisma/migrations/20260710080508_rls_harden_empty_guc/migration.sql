-- Harden fail-closed: NULLIF maps both an unset GUC (NULL) and a reverted-to-empty
-- GUC ('') to NULL, so RLS uniformly returns zero rows instead of erroring on ''::uuid.
DROP POLICY IF EXISTS notes_org_isolation ON "notes";
CREATE POLICY notes_org_isolation ON "notes"
  USING (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

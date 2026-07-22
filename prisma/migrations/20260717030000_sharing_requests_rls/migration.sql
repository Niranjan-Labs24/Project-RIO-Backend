ALTER TABLE "sharing_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sharing_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY sharing_requests_two_party ON "sharing_requests"
  TO cnap_app
  USING (
    "owner_org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR "requesting_org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    "owner_org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
    OR "requesting_org_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid
  );

CREATE POLICY sharing_requests_supervisor_read ON "sharing_requests"
  FOR SELECT TO cnap_supervisor USING (true);

-- Guard against exactly the accident that happened on 2026-08-18: deleting
-- an organisation cascade-deletes its users (users_org_id_fkey ON DELETE
-- CASCADE), and cross-entity roles (System Admin, System Reviewer, Center
-- Supervisor) are still required to have an orgId even though it plays no
-- real role in their access control — runAsSupervisor() never reads
-- app.current_org_id, so that FK value is a schema formality, not something
-- meaningful to lose an admin account over.
--
-- This is a DB-level trigger, not an application-service check, on purpose:
-- the incident it guards against was a direct SQL DELETE, not a call
-- through the app's own API — an application-layer guard alone would not
-- have caught it. Blocks deletion at the database level regardless of
-- caller (app, script, or a raw psql session), until a proper fix (making
-- orgId nullable for cross-entity roles) lands.
CREATE OR REPLACE FUNCTION prevent_org_delete_with_cross_entity_user()
RETURNS TRIGGER AS $$
DECLARE
  blocking_count INTEGER;
BEGIN
  SELECT count(*) INTO blocking_count
  FROM users u
  JOIN roles r ON r.id = u.role_id
  WHERE u.org_id = OLD.id AND r.cross_entity = true;

  IF blocking_count > 0 THEN
    RAISE EXCEPTION
      'Cannot delete organisation "%" (%): % cross-entity user(s) (System Admin / System Reviewer / Center Supervisor) are still homed here. Reassign or remove those users first.',
      OLD.name, OLD.id, blocking_count;
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_org_delete_with_cross_entity_user ON organisations;
CREATE TRIGGER trg_prevent_org_delete_with_cross_entity_user
  BEFORE DELETE ON organisations
  FOR EACH ROW
  EXECUTE FUNCTION prevent_org_delete_with_cross_entity_user();

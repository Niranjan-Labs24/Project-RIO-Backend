import { getOrgStore } from "../../tenancy/org-context";

/**
 * The platform-wide roles that read across entities.
 *
 * Same list and same reasoning as NeedsService.listByStudyId, which hit this
 * exact problem first: a crossEntity role has no tenant org of its own, so an
 * RLS-scoped query returns zero for it and the screen looks broken rather than
 * empty-by-design. RIO-RBAC-002 and Q29 both treat this oversight read as
 * existing, approved behaviour.
 *
 * Kept local to this module rather than shared, matching how NeedsService and
 * StudiesService each declare it — a change to who may read across entities
 * should be a deliberate edit per feature, not a silent widening everywhere.
 *
 * ncnp_user is on THIS list and not on the other two on purpose. Q9 names the
 * cross-entity duplicate queue as "Center/NCNP only", so NCNP oversight is one
 * of its intended readers. It also has cross_entity = true in the roles table,
 * which is what the UI gates the section on — leaving it out here would have
 * shown an NCNP user a queue that always came back empty, which reads as a
 * broken screen rather than a boundary.
 */
export function isCrossOrgReader(): boolean {
  const role = getOrgStore()?.role;
  return (
    role === "system_admin" ||
    role === "system_reviewer" ||
    role === "center_supervisor" ||
    role === "ncnp_user"
  );
}

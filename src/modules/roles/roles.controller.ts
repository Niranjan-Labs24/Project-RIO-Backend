import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { ROLE_MATRIX, type RoleDef } from '../../rbac/role-matrix';

@Controller('roles')
export class RolesController {
  // Bug fix (Aug 13): this was gated on rolesPermissions:read — the Roles &
  // Permissions *admin* page's own concern (creating/editing roles, still
  // separately protected by its own PermissionGuard on the frontend route).
  // Confirmed matrix gives most roles "Roles & Permissions = —", so any
  // caller without it (e.g. NGO Admin) got a silent 403 here, which starved
  // the Users page's "assignable roles" dropdown and hid the Create User
  // button entirely — a real bug, not intended scope. Listing which roles
  // exist (read-only, no grant details a caller couldn't already infer from
  // their own team) is a basic part of managing a team, not role
  // administration — entityTeam:read is the correct, narrower gate.
  @Get()
  @RequirePermission('entityTeam', 'read')
  list(): RoleDef[] {
    return ROLE_MATRIX;
  }
}

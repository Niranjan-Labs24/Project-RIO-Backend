import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { ROLE_MATRIX, type RoleDef } from '../../rbac/role-matrix';

@Controller('roles')
export class RolesController {
  @Get()
  @RequirePermission('rolesPermissions', 'read')
  list(): RoleDef[] {
    return ROLE_MATRIX;
  }
}

import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { CreatePermissionGrantBody, type CreatePermissionGrantDto } from './permission-grants.contract';
import { PermissionGrantsService } from './permission-grants.service';
import type { PermissionGrant } from './permission-grants.types';

// RIO-RBAC-002 — only System Admin holds rolesPermissions:write (see
// role-matrix.ts), matching the client's "approved permission grant"
// language — a grant only ever comes from System Admin.
@Controller('permission-grants')
export class PermissionGrantsController {
  constructor(private readonly grants: PermissionGrantsService) {}

  @Get()
  @RequirePermission('rolesPermissions', 'read')
  list(): Promise<PermissionGrant[]> {
    return this.grants.list();
  }

  @Post()
  @RequirePermission('rolesPermissions', 'write')
  create(
    @Body(new TypeBoxValidationPipe(CreatePermissionGrantBody)) body: CreatePermissionGrantDto,
  ): Promise<PermissionGrant> {
    return this.grants.create(body);
  }

  @Patch(':id/revoke')
  @RequirePermission('rolesPermissions', 'write')
  revoke(@Param('id', new UuidParamPipe()) id: string): Promise<PermissionGrant> {
    return this.grants.revoke(id);
  }
}

import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { UsersService } from './users.service';
import type { InviteUserPayload, OrgUser, UpdateUserPayload } from './users.types';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // ?organizationId → System-Admin cross-org list (crossEntity enforced in the service).
  @Get()
  @RequirePermission('entityTeam', 'read')
  list(@Query('organizationId') organizationId?: string): Promise<OrgUser[]> {
    return organizationId ? this.users.listForOrg(organizationId) : this.users.list();
  }

  @Post()
  @RequirePermission('entityTeam', 'create')
  invite(@Body() body: InviteUserPayload): Promise<OrgUser> {
    if (!body?.name || !body?.email || !body?.roleId) {
      throw new BadRequestException({ error: { code: 'VALIDATION_ERROR', message: 'name, email and roleId are required' } });
    }
    return this.users.invite(body);
  }

  @Patch(':id')
  @RequirePermission('entityTeam', 'write')
  update(@Param('id') id: string, @Body() body: UpdateUserPayload): Promise<OrgUser> {
    return this.users.update(id, body ?? {});
  }
}

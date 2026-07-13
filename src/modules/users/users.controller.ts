import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { parseIntParam } from '../../common/http/query.util';
import { InviteUserBody, UpdateUserBody } from './users.contract';
import { UsersService } from './users.service';
import type { InviteUserPayload, OrgUser, UpdateUserPayload } from './users.types';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // ?organizationId → System-Admin cross-org list (crossEntity enforced in the service).
  @Get()
  @RequirePermission('entityTeam', 'read')
  list(
    @Query('organizationId') organizationId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<OrgUser[]> {
    const page = { limit: parseIntParam(limit), offset: parseIntParam(offset) };
    return organizationId ? this.users.listForOrg(organizationId, page) : this.users.list(page);
  }

  @Post()
  @RequirePermission('entityTeam', 'create')
  invite(@Body(new TypeBoxValidationPipe(InviteUserBody)) body: InviteUserPayload): Promise<OrgUser> {
    return this.users.invite(body);
  }

  @Patch(':id')
  @RequirePermission('entityTeam', 'write')
  update(@Param('id') id: string, @Body(new TypeBoxValidationPipe(UpdateUserBody)) body: UpdateUserPayload): Promise<OrgUser> {
    return this.users.update(id, body ?? {});
  }
}

import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { parseIntParam } from '../../common/http/query.util';
import { CreateOrganizationBody, UpdateOrganizationBody, UpdateOrganizationStatusBody } from './organizations.contract';
import { OrganizationsService } from './organizations.service';
import { UsersService } from '../users/users.service';
import { AssignNgoAdminBody, UpdateUserRoleBody, UpdateUserStatusBody, InviteUserBody } from '../users/users.contract';
import type {
  CreateOrganizationPayload, Organization, OrganizationSummary, UpdateOrganizationPayload, UpdateOrganizationStatusPayload,
} from './organizations.types';
import type {
  AssignNgoAdminPayload, InviteUserPayload, InviteUserResponse, OrgUser, UpdateUserRolePayload, UpdateUserStatusPayload,
} from '../users/users.types';

@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly orgs: OrganizationsService,
    private readonly users: UsersService,
  ) {}

  // 'current' routes are declared before ':id' so they are matched first.
  @Get('current')
  getCurrent(): Promise<Organization> {
    return this.orgs.getCurrent();
  }

  @Patch('current')
  @RequirePermission('entityTeam', 'write')
  updateCurrent(@Body(new TypeBoxValidationPipe(UpdateOrganizationBody)) body: UpdateOrganizationPayload): Promise<Organization> {
    return this.orgs.updateCurrent(body ?? {});
  }

  @Get()
  @RequirePermission('entityTeam', 'read')
  listAll(@Query('limit') limit?: string, @Query('offset') offset?: string): Promise<OrganizationSummary[]> {
    return this.orgs.listAll({ limit: parseIntParam(limit), offset: parseIntParam(offset) });
  }

  @Get(':id')
  @RequirePermission('entityTeam', 'read')
  getById(@Param('id', new UuidParamPipe()) id: string): Promise<OrganizationSummary> {
    return this.orgs.getById(id);
  }

  @Patch(':id/status')
  @RequirePermission('entityTeam', 'write')
  updateStatus(
    @Param('id') id: string,
    @Body(new TypeBoxValidationPipe(UpdateOrganizationStatusBody)) body: UpdateOrganizationStatusPayload,
  ): Promise<OrganizationSummary> {
    return this.orgs.updateStatus(id, body);
  }

  @Post()
  @RequirePermission('entityTeam', 'create')
  createWithAdmin(@Body(new TypeBoxValidationPipe(CreateOrganizationBody)) body: CreateOrganizationPayload): Promise<Organization> {
    return this.orgs.createWithAdmin(body);
  }

  @Get(':id/users')
  @RequirePermission('entityTeam', 'read')
  listUsersForOrg(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<OrgUser[]> {
    return this.users.listForOrg(id, { limit: parseIntParam(limit), offset: parseIntParam(offset) });
  }

  @Get(':id/ngoadmins')
  @RequirePermission('entityTeam', 'read')
  getNgoAdminsForOrg(@Param('id') id: string): Promise<OrgUser[]> {
    return this.users.getNgoAdminsForOrg(id);
  }

  @Post(':id/users')
  @RequirePermission('entityTeam', 'write')
  createUserForOrg(
    @Param('id') id: string,
    @Body(new TypeBoxValidationPipe(InviteUserBody)) body: InviteUserPayload,
  ): Promise<InviteUserResponse> {
    return this.users.createForOrg({ ...body, organizationId: id });
  }

  @Post(':id/ngoadmins/assign')
  @RequirePermission('entityTeam', 'write')
  assignNgoAdmin(
    @Param('id') id: string,
    @Body(new TypeBoxValidationPipe(AssignNgoAdminBody)) body: AssignNgoAdminPayload,
  ): Promise<InviteUserResponse> {
    return this.users.assignNgoAdmin(id, body);
  }

  @Patch(':id/users/:userId/role')
  @RequirePermission('entityTeam', 'write')
  updateUserRole(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body(new TypeBoxValidationPipe(UpdateUserRoleBody)) body: UpdateUserRolePayload,
  ): Promise<OrgUser> {
    return this.users.updateUserRoleForOrg(id, userId, body);
  }

  @Patch(':id/users/:userId/status')
  @RequirePermission('entityTeam', 'write')
  updateUserStatus(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Body(new TypeBoxValidationPipe(UpdateUserStatusBody)) body: UpdateUserStatusPayload,
  ): Promise<OrgUser> {
    return this.users.updateUserStatusForOrg(id, userId, body);
  }

  @Post(':id/users/:userId/resend-invite')
  @RequirePermission('entityTeam', 'write')
  resendInvite(
    @Param('id') id: string,
    @Param('userId') userId: string,
  ): Promise<InviteUserResponse> {
    return this.users.resendInviteForOrg(id, userId);
  }
}

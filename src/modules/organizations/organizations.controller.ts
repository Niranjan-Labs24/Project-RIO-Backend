import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { parseIntParam } from '../../common/http/query.util';
import { CreateOrganizationBody, UpdateOrganizationBody } from './organizations.contract';
import { OrganizationsService } from './organizations.service';
import type {
  CreateOrganizationPayload, Organization, OrganizationSummary, UpdateOrganizationPayload,
} from './organizations.types';

@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  // 'current' routes are declared before ':id' so they are matched first.
  // No @RequirePermission here, deliberately — this is "read my own org's
  // basic profile" (name, villages, sector, logo), not an entityTeam/admin
  // concern. Every authenticated role needs it for ordinary operational use
  // (e.g. the Governorate picker on Study/Need creation forms), and
  // JwtAuthGuard (see app.module.ts) already guarantees a valid session —
  // this only ever returns the caller's own org, never another one. Gating
  // it on `entityTeam` (which only System Admin/Center Supervisor/NGO Admin
  // hold) silently 403'd every other role's Governorate picker down to an
  // empty options list, which then rendered a misleading "all governorates
  // already added" message instead of any indication of the real problem.
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
  getById(@Param('id') id: string): Promise<OrganizationSummary> {
    return this.orgs.getById(id);
  }

  @Post()
  @RequirePermission('entityTeam', 'create')
  createWithAdmin(@Body(new TypeBoxValidationPipe(CreateOrganizationBody)) body: CreateOrganizationPayload): Promise<Organization> {
    return this.orgs.createWithAdmin(body);
  }
}

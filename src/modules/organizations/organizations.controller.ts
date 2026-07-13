import { BadRequestException, Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { OrganizationsService } from './organizations.service';
import type {
  CreateOrganizationPayload, Organization, OrganizationSummary, UpdateOrganizationPayload,
} from './organizations.types';

@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  // 'current' routes are declared before ':id' so they are matched first.
  @Get('current')
  @RequirePermission('entityTeam', 'read')
  getCurrent(): Promise<Organization> {
    return this.orgs.getCurrent();
  }

  @Patch('current')
  @RequirePermission('entityTeam', 'write')
  updateCurrent(@Body() body: UpdateOrganizationPayload): Promise<Organization> {
    return this.orgs.updateCurrent(body ?? {});
  }

  @Get()
  @RequirePermission('entityTeam', 'read')
  listAll(): Promise<OrganizationSummary[]> {
    return this.orgs.listAll();
  }

  @Get(':id')
  @RequirePermission('entityTeam', 'read')
  getById(@Param('id') id: string): Promise<OrganizationSummary> {
    return this.orgs.getById(id);
  }

  @Post()
  @RequirePermission('entityTeam', 'create')
  createWithAdmin(@Body() body: CreateOrganizationPayload): Promise<Organization> {
    if (!body?.name || !body?.adminName || !body?.adminEmail) {
      throw new BadRequestException({
        error: { code: 'VALIDATION_ERROR', message: 'name, adminName and adminEmail are required' },
      });
    }
    return this.orgs.createWithAdmin(body);
  }
}

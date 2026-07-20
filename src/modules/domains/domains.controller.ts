import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import {
  CreateDomainBody, CreateSubDomainBody, UpdateDomainBody, UpdateSubDomainBody,
} from './domains.contract';
import { DomainsService } from './domains.service';
import type {
  CreateDomainPayload, CreateSubDomainPayload, Domain, DomainWithSubDomains, SubDomain, UpdateDomainPayload, UpdateSubDomainPayload,
} from './domains.types';

// Reads open to nearly every role (methodologyQuestionBank RO is granted
// broadly across ROLE_MATRIX); writes/create/activate/deactivate are
// restricted to ngo_admin, the only role with full CRUD on this module —
// no RBAC changes needed for this module.
@Controller('domains')
export class DomainsController {
  constructor(private readonly domains: DomainsService) {}

  @Get()
  @RequirePermission('methodologyQuestionBank', 'read')
  listDomains(): Promise<Domain[]> {
    return this.domains.listDomains();
  }

  // One round trip for every active domain's active sub-domains — used by
  // AI Classification's override modal and Survey Builder instead of the
  // old listDomains() + one listSubDomains() call per domain.
  @Get('tree')
  @RequirePermission('methodologyQuestionBank', 'read')
  listDomainsWithSubDomains(): Promise<DomainWithSubDomains[]> {
    return this.domains.listDomainsWithSubDomains();
  }

  @Post()
  @RequirePermission('methodologyQuestionBank', 'write')
  createDomain(@Body(new TypeBoxValidationPipe(CreateDomainBody)) body: CreateDomainPayload): Promise<Domain> {
    return this.domains.createDomain(body);
  }

  @Patch(':id')
  @RequirePermission('methodologyQuestionBank', 'write')
  updateDomain(
    @Param('id') id: string,
    @Body(new TypeBoxValidationPipe(UpdateDomainBody)) body: UpdateDomainPayload,
  ): Promise<Domain> {
    return this.domains.updateDomain(id, body);
  }

  @Patch(':id/activate')
  @RequirePermission('methodologyQuestionBank', 'write')
  activateDomain(@Param('id') id: string): Promise<Domain> {
    return this.domains.setDomainActive(id, true);
  }

  @Patch(':id/deactivate')
  @RequirePermission('methodologyQuestionBank', 'write')
  deactivateDomain(@Param('id') id: string): Promise<Domain> {
    return this.domains.setDomainActive(id, false);
  }

  @Get(':id/subdomains')
  @RequirePermission('methodologyQuestionBank', 'read')
  listSubDomains(@Param('id') id: string): Promise<SubDomain[]> {
    return this.domains.listSubDomains(id);
  }

  @Post(':id/subdomains')
  @RequirePermission('methodologyQuestionBank', 'write')
  createSubDomain(
    @Param('id') id: string,
    @Body(new TypeBoxValidationPipe(CreateSubDomainBody)) body: CreateSubDomainPayload,
  ): Promise<SubDomain> {
    return this.domains.createSubDomain(id, body);
  }

  @Patch(':id/subdomains/:subId')
  @RequirePermission('methodologyQuestionBank', 'write')
  updateSubDomain(
    @Param('id') id: string,
    @Param('subId') subId: string,
    @Body(new TypeBoxValidationPipe(UpdateSubDomainBody)) body: UpdateSubDomainPayload,
  ): Promise<SubDomain> {
    return this.domains.updateSubDomain(id, subId, body);
  }

  @Patch(':id/subdomains/:subId/activate')
  @RequirePermission('methodologyQuestionBank', 'write')
  activateSubDomain(@Param('id') id: string, @Param('subId') subId: string): Promise<SubDomain> {
    return this.domains.setSubDomainActive(id, subId, true);
  }

  @Patch(':id/subdomains/:subId/deactivate')
  @RequirePermission('methodologyQuestionBank', 'write')
  deactivateSubDomain(@Param('id') id: string, @Param('subId') subId: string): Promise<SubDomain> {
    return this.domains.setSubDomainActive(id, subId, false);
  }
}

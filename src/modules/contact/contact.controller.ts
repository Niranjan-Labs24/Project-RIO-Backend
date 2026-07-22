import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { CsrfExempt } from '../../common/guards/csrf.guard';
import { Public } from '../../auth/public.decorator';
import { RateLimit } from '../../common/guards/rate-limit.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import { ContactBody, type ContactDto } from './contact.contract';
import { ContactService } from './contact.service';
import type { ContactSubmissionResult, PublicOrganizationOption } from './contact.types';

/**
 * Both routes are open by design — this is the enquiry form on the public auth
 * pages, reached by people who cannot sign in. They carry no @RequirePermission
 * (the guard passes routes it finds no constraint on) and are @CsrfExempt: an
 * anonymous caller has never been issued a rio_csrf cookie, so there is nothing
 * for it to double-submit.
 *
 * The service is read-only via runAsSupervisor, which is what keeps that safe:
 * a public route cannot write tenant data.
 */
@Controller('contact')
@Public()
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  @Get('organizations')
  @CsrfExempt()
  listOrganizations(): Promise<PublicOrganizationOption[]> {
    return this.contact.listOrganizations();
  }

  @Post()
  @RateLimit(5, 3600)
  @HttpCode(200)
  @CsrfExempt()
  submit(@Body(new TypeBoxValidationPipe(ContactBody)) body: ContactDto): Promise<ContactSubmissionResult> {
    return this.contact.submit(body);
  }
}

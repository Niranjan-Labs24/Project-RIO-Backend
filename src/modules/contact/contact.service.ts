import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { MailerService } from '../../mailer/mailer.service';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import type { ContactDto } from './contact.contract';
import type { ContactSubmissionResult, PublicOrganizationOption } from './contact.types';

/** The seeded Role.id for NGO Research Officer (see src/rbac/role-matrix.ts). */
const RESEARCH_OFFICER_ROLE_ID = 'role_ngo_research_officer';
/** Fallback recipient: an org always has an admin, but need not have a
*  research officer — without this the enquiry would be silently dropped. */
const NGO_ADMIN_ROLE_ID = 'role_ngo_admin';

/**
* Public contact enquiries from the unauthenticated auth pages.
*
* Every read here runs through `runAsSupervisor` — the SELECT-only cross-org
* client — because there is no session and therefore no org GUC to satisfy
* RLS. This is the same pre-context path `AuthService.login` uses to find a
* user by email. It is read-only by construction, which is what we want: a
* public endpoint should not be able to write tenant data.
*/
@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly mailer: MailerService,
  ) {}

  /**
   * Organisations offered in the contact form's picker. Deliberately exposes
   * `id` and `name` only, and only for active orgs — this is unauthenticated,
   * so it is the one place org data leaves the system without a session.
   */
  async listOrganizations(): Promise<PublicOrganizationOption[]> {
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.organisation.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    );
    return rows.map((row) => ({ id: row.id, name: row.name }));
  }

  async submit(dto: ContactDto): Promise<ContactSubmissionResult> {
    const org = await this.tenant.runAsSupervisor((tx) =>
      tx.organisation.findFirst({
        where: { id: dto.organizationId, isActive: true },
        select: { id: true, name: true },
      }),
    );
    if (!org) {
      throw new NotFoundException({
        error: { code: 'ORG_NOT_FOUND', message: 'Organization not found' },
      });
    }

    const recipients = await this.recipientsFor(org.id);
    if (recipients.length === 0) {
      // Nobody to route to. Fail loudly rather than reporting success for a
      // message that would go nowhere.
      this.logger.warn(`Contact enquiry for org ${org.id} has no deliverable recipient`);
      throw new ServiceUnavailableException({
        error: {
          code: 'NO_CONTACT_RECIPIENT',
          message: 'This organization has no contact available right now.',
        },
      });
    }

    const delivered = await this.mailer.sendContactRequest(recipients, {
      orgName: org.name,
      name: dto.name,
      email: dto.email,
      region: dto.region,
      purpose: dto.purpose,
    });
    if (!delivered) {
      // sendContactRequest swallows transport errors and returns false, so an
      // unconfigured or failing mailer looks identical here. Either way the
      // enquiry was not delivered and the sender must not be told it was.
      throw new ServiceUnavailableException({
        error: {
          code: 'CONTACT_DELIVERY_FAILED',
          message: 'We could not send your message right now. Please try again later.',
        },
      });
    }
    return { delivered, recipientCount: recipients.length };
  }

  /**
   * The org's active research officers, falling back to its admins. Only
   * `active` users are considered: an `invited` user has never signed in and
   * may not be reading that mailbox.
   */
  private async recipientsFor(orgId: string): Promise<string[]> {
    const emailsFor = (roleId: string): Promise<{ email: string }[]> =>
      this.tenant.runAsSupervisor((tx) =>
        tx.user.findMany({
          where: { orgId, roleId, status: 'active' },
          select: { email: true },
        }),
      );

    const officers = await emailsFor(RESEARCH_OFFICER_ROLE_ID);
    if (officers.length > 0) return officers.map((u) => u.email);

    const admins = await emailsFor(NGO_ADMIN_ROLE_ID);
    if (admins.length > 0) {
      this.logger.warn(`Org ${orgId} has no active research officer — falling back to NGO admins`);
      return admins.map((u) => u.email);
    }
    return [];
  }
}
 
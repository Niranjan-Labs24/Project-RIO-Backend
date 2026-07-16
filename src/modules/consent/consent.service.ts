import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { ActiveConsentPolicy } from './consent.types';

// `consent_policies` is a global reference table (no RLS, plain SELECT grant
// — same as `roles`/`role_permissions`), so this reads via the bare
// PrismaService, no org context needed. Matches AuthRepository's own lookup
// of the active policy during signup.
@Injectable()
export class ConsentService {
  constructor(private readonly prisma: PrismaService) {}

  async getActivePolicy(): Promise<ActiveConsentPolicy> {
    const policy = await this.prisma.consentPolicy.findFirst({
      where: { active: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!policy) {
      throw new NotFoundException({
        error: { code: 'NO_ACTIVE_CONSENT_POLICY', message: 'No active consent policy is configured.' },
      });
    }
    return { version: policy.version, text: policy.text };
  }
}

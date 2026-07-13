import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeEmail, normalizeRegistrationNumber } from '../../common/normalize.util';

/**
 * Thrown when a create hits the DB's unique constraint despite an earlier
 * "does this already exist" check having come back clear — the check and
 * the insert aren't atomic, so two concurrent signups for the same
 * registration number/email can both pass the check and race to insert.
 * The constraint is the actual source of truth; this just gives the
 * service layer a typed signal to translate into the same friendly 409
 * the upfront check produces, instead of letting a raw Postgres/Prisma
 * error reach the client as a 500.
 */
export class UniqueConstraintError extends Error {
  constructor(public readonly field: 'registrationNumber' | 'email') {
    super(`Unique constraint violated on ${field}`);
    this.name = 'UniqueConstraintError';
  }
}

function isUniqueConstraintViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Prisma reports the violated column(s) in `meta.target` — shape varies by driver, so check loosely. */
function violatedField(
  error: Prisma.PrismaClientKnownRequestError,
): 'registrationNumber' | 'email' | null {
  const target = error.meta?.['target'];
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  if (text.includes('registration_number')) return 'registrationNumber';
  if (text.includes('email')) return 'email';
  return null;
}

export interface AuthUserRow {
  id: string;
  orgId: string;
  name: string;
  email: string;
  passwordHash: string;
  role: string;
  mustChangePassword: boolean;
}

export interface AuthOrganisationRow {
  id: string;
  name: string;
  purpose: string;
  registrationNumber: string;
}

export interface CreateOrganisationAndAdminInput {
  organizationName: string;
  purpose: string;
  registrationNumber: string;
  adminName: string;
  email: string;
  passwordHash: string;
}

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `organisations` carries no RLS (it's the tenant root — see the
   * 20260710084255_rls_users_policy migration's note), so this is a plain,
   * unscoped lookup: no org context needed before an org exists.
   */
  async findOrganisationByRegistrationNumber(
    registrationNumber: string,
  ): Promise<AuthOrganisationRow | null> {
    return this.prisma.organisation.findUnique({
      where: { registrationNumber: normalizeRegistrationNumber(registrationNumber) },
      select: { id: true, name: true, purpose: true, registrationNumber: true },
    });
  }

  /** Same no-RLS reasoning as above — used to resolve the org for a session after login. */
  async findOrganisationById(id: string): Promise<AuthOrganisationRow | null> {
    return this.prisma.organisation.findUnique({
      where: { id },
      select: { id: true, name: true, purpose: true, registrationNumber: true },
    });
  }

  /**
   * `users` has FORCE ROW LEVEL SECURITY scoped to org_id — finding a user
   * by email before any org context exists (login, signup's email check)
   * needs the narrow `users_auth_lookup` policy (see the
   * 20260713120100_auth_grants_and_lookup_policy migration), enabled only
   * for the lifetime of this one transaction via a transaction-local GUC.
   * Never reuse this pattern outside auth flows — it's the one deliberate,
   * narrowly-scoped exception to the tenant-isolation guarantee.
   */
  async findUserByEmailForAuth(email: string): Promise<AuthUserRow | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_auth_lookup', 'true', true)`;
      return tx.user.findUnique({
        where: { email: normalizeEmail(email) },
        select: {
          id: true,
          orgId: true,
          name: true,
          email: true,
          passwordHash: true,
          role: true,
          mustChangePassword: true,
        },
      });
    });
  }

  /** Same auth-lookup exemption as above, keyed by id instead — used by GET /auth/me. */
  async findUserByIdForAuth(id: string): Promise<AuthUserRow | null> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_auth_lookup', 'true', true)`;
      return tx.user.findUnique({
        where: { id },
        select: {
          id: true,
          orgId: true,
          name: true,
          email: true,
          passwordHash: true,
          role: true,
          mustChangePassword: true,
        },
      });
    });
  }

  /**
   * Creates a brand-new organisation and its first NGO Admin together, in
   * one transaction. The org row is inserted first (no RLS blocks it), then
   * `app.current_org_id` is set to the freshly-generated org id for the
   * remainder of this transaction — a legitimate use of the same org-context
   * mechanism `TenantPrismaService` uses post-auth, just scoped to "act as
   * the org that was just created" rather than one read from request state.
   * That satisfies the `users_org_isolation` WITH CHECK policy without
   * needing the `users_auth_lookup` policy at all for this half.
   *
   * `AuthService.signup()` already checked registrationNumber/email don't
   * exist before calling this — but that check and this insert aren't
   * atomic, so a concurrent signup can still slip in between them and win
   * the race. Throws `UniqueConstraintError` in that case instead of
   * letting the raw DB error escape, so the service layer can respond with
   * the same friendly 409 either way.
   */
  async createOrganisationAndAdmin(
    input: CreateOrganisationAndAdminInput,
  ): Promise<{ organisation: AuthOrganisationRow; user: AuthUserRow }> {
    const registrationNumber = normalizeRegistrationNumber(input.registrationNumber);
    const email = normalizeEmail(input.email);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const organisation = await tx.organisation.create({
          data: {
            name: input.organizationName,
            purpose: input.purpose,
            registrationNumber,
          },
          select: { id: true, name: true, purpose: true, registrationNumber: true },
        });

        await tx.$executeRaw`SELECT set_config('app.current_org_id', ${organisation.id}, true)`;

        const user = await tx.user.create({
          data: {
            orgId: organisation.id,
            name: input.adminName,
            email,
            passwordHash: input.passwordHash,
            role: 'ngo_admin',
          },
          select: {
            id: true,
            orgId: true,
            name: true,
            email: true,
            passwordHash: true,
            role: true,
            mustChangePassword: true,
          },
        });

        return { organisation, user };
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new UniqueConstraintError(violatedField(error) ?? 'registrationNumber');
      }
      throw error;
    }
  }

  /**
   * Sets a user's own password and clears `mustChangePassword` — the one
   * write the signed-in user makes on themselves (see
   * AuthService.changePassword()). `users_org_isolation`'s existing
   * USING/WITH CHECK (org_id = app.current_org_id) already covers UPDATE,
   * so this only needs that GUC set for the transaction, same pattern as
   * `createOrganisationAndAdmin`'s insert half — no new policy required.
   */
  async updatePassword(userId: string, orgId: string, passwordHash: string): Promise<AuthUserRow> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      return tx.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: false },
        select: {
          id: true,
          orgId: true,
          name: true,
          email: true,
          passwordHash: true,
          role: true,
          mustChangePassword: true,
        },
      });
    });
  }
}

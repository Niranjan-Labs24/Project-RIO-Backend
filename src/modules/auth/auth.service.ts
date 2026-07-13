import { ConflictException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { generateTemporaryPassword, hashPassword, verifyPassword } from '../../common/password.util';
import { ConfigService } from '../../config/config.service';
import { MailerService } from '../../mailer/mailer.service';
import { signSessionToken, verifySessionToken } from '../../common/session.util';
import {
  AuthRepository,
  UniqueConstraintError,
  type AuthOrganisationRow,
  type AuthUserRow,
} from './auth.repository';
import type {
  ChangePasswordDto,
  LoginDto,
  SessionView,
  SignupDto,
  SignupResponseView,
} from './auth.contract';

/**
 * One message per uniqueness field, shared by the upfront check and the
 * unique-constraint-race fallback (see `AuthService.signup()`) so a caller
 * gets the identical response either way — which path caught the
 * duplicate is an implementation detail, not something worth exposing.
 */
function conflictFor(field: 'registrationNumber' | 'email'): ConflictException {
  if (field === 'registrationNumber') {
    return new ConflictException({
      error: {
        code: 'ORGANIZATION_ALREADY_REGISTERED',
        message:
          'An administrator already exists for this organization. Please contact your organization administrator.',
      },
    });
  }
  return new ConflictException({
    error: {
      code: 'EMAIL_ALREADY_REGISTERED',
      message: 'An account with this email already exists.',
    },
  });
}

function toSessionView(
  user: AuthUserRow,
  organisation: AuthOrganisationRow,
  token: string,
): SessionView {
  return {
    token,
    user: { id: user.id, name: user.name, email: user.email },
    organization: {
      id: organisation.id,
      name: organisation.name,
      purpose: organisation.purpose,
      registrationNumber: organisation.registrationNumber,
    },
    role: { key: user.role },
    mustChangePassword: user.mustChangePassword,
  };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly repo: AuthRepository,
    private readonly config: ConfigService,
    private readonly mailer: MailerService,
  ) {}

  /**
   * Creates a new organisation and its first NGO Admin together — no
   * user-chosen password, no separate admin name: the signup email *is*
   * the NGO Admin account, and a temporary password is generated
   * server-side. That password is emailed via `MailerService` whenever
   * it's configured (RESEND_API_KEY set); if it isn't (or the send
   * fails), this falls back to its pre-mailer behavior — logging it and
   * including it in the response body, and only outside production, so a
   * real deployment without a working mailer fails safely (no password
   * anywhere) rather than leaking one. The registration-number check runs
   * first and is the uniqueness key — org name is intentionally not
   * checked, matching the frontend's `authService.signup()`.
   */
  async signup(dto: SignupDto): Promise<SignupResponseView> {
    const existingOrg = await this.repo.findOrganisationByRegistrationNumber(
      dto.registrationNumber,
    );
    if (existingOrg) {
      throw conflictFor('registrationNumber');
    }

    const existingUser = await this.repo.findUserByEmailForAuth(dto.email);
    if (existingUser) {
      throw conflictFor('email');
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    let organisation: AuthOrganisationRow;
    let user: AuthUserRow;
    try {
      ({ organisation, user } = await this.repo.createOrganisationAndAdmin({
        organizationName: dto.organizationName,
        purpose: dto.purpose,
        registrationNumber: dto.registrationNumber,
        // No admin-name input in this phase — the signup email is the
        // whole identity. This is a display placeholder, not a real name;
        // revisit once there's an actual "who is this person" field.
        adminName: `${dto.organizationName} Admin`,
        email: dto.email,
        passwordHash,
      }));
    } catch (error) {
      // The upfront checks above passed, but a concurrent signup for the
      // same registration number/email could still have won the race
      // between then and this insert — the DB's unique constraint is the
      // real source of truth. Same response either way.
      if (error instanceof UniqueConstraintError) {
        throw conflictFor(error.field);
      }
      throw error;
    }

    const token = signSessionToken(
      { sub: user.id, orgId: organisation.id, role: user.role },
      this.config.jwtSecret,
    );
    const session = toSessionView(user, organisation, token);

    const emailed = await this.mailer.sendTemporaryPassword(
      user.email,
      organisation.name,
      temporaryPassword,
    );
    if (emailed) {
      this.logger.log(`Temporary password emailed to ${user.email}`);
      return { ...session, temporaryPasswordEmailed: true };
    }

    // Mailer isn't configured yet (no RESEND_API_KEY) or the send failed —
    // fall back to the pre-mailer behavior, and only outside production,
    // so a real deployment without a working mailer fails safely (no
    // password anywhere reachable) rather than leaking one.
    if (this.config.nodeEnv !== 'production') {
      this.logger.log(`[dev-only] Temporary password for ${user.email}: ${temporaryPassword}`);
      return { ...session, temporaryPasswordEmailed: false, temporaryPassword };
    }
    return { ...session, temporaryPasswordEmailed: false };
  }

  async login(dto: LoginDto): Promise<SessionView> {
    const user = await this.repo.findUserByEmailForAuth(dto.email);
    // Same generic message either way — don't reveal whether the email
    // exists.
    if (!user || !(await verifyPassword(dto.password, user.passwordHash))) {
      throw new UnauthorizedException({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
      });
    }

    const organisation = await this.repo.findOrganisationById(user.orgId);
    if (!organisation) {
      // Data-integrity fault, not a client error — every user must have an org.
      throw new Error(`User ${user.id} references missing organisation ${user.orgId}`);
    }

    const token = signSessionToken(
      { sub: user.id, orgId: organisation.id, role: user.role },
      this.config.jwtSecret,
    );
    return toSessionView(user, organisation, token);
  }

  /** Resolves the session cookie's JWT back into a full session view for GET /auth/me. */
  async resolveSession(token: string): Promise<SessionView> {
    const payload = verifySessionToken(token, this.config.jwtSecret);
    if (!payload) {
      throw new UnauthorizedException({
        error: { code: 'NOT_AUTHENTICATED', message: 'Not authenticated.' },
      });
    }

    const user = await this.repo.findUserByIdForAuth(payload.sub);
    const organisation = user ? await this.repo.findOrganisationById(user.orgId) : null;
    if (!user || !organisation) {
      throw new UnauthorizedException({
        error: { code: 'NOT_AUTHENTICATED', message: 'Not authenticated.' },
      });
    }

    return toSessionView(user, organisation, token);
  }

  /**
   * Sets the signed-in user's own password — the one path off a
   * signup-issued temp password (`mustChangePassword: true`) onto one they
   * chose. Requires the current password to verify identity beyond the
   * session cookie alone (matches the login check, same generic reasoning:
   * confirm the caller actually knows the password being replaced). The
   * session token itself is unchanged (sub/orgId/role don't change), so
   * it's reused rather than reissued.
   */
  async changePassword(token: string, dto: ChangePasswordDto): Promise<SessionView> {
    const payload = verifySessionToken(token, this.config.jwtSecret);
    if (!payload) {
      throw new UnauthorizedException({
        error: { code: 'NOT_AUTHENTICATED', message: 'Not authenticated.' },
      });
    }

    const user = await this.repo.findUserByIdForAuth(payload.sub);
    if (!user || !(await verifyPassword(dto.currentPassword, user.passwordHash))) {
      throw new UnauthorizedException({
        error: {
          code: 'INVALID_CURRENT_PASSWORD',
          message: 'Current password is incorrect.',
        },
      });
    }

    const newPasswordHash = await hashPassword(dto.newPassword);
    const updatedUser = await this.repo.updatePassword(user.id, user.orgId, newPasswordHash);

    const organisation = await this.repo.findOrganisationById(updatedUser.orgId);
    if (!organisation) {
      throw new Error(`User ${updatedUser.id} references missing organisation ${updatedUser.orgId}`);
    }

    return toSessionView(updatedUser, organisation, token);
  }
}

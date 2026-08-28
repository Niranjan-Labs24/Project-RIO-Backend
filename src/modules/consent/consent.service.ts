import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireActor } from '../../tenancy/org-context';
import { requireNonBlank } from '../../common/validation/require-non-blank';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import { CONSENT_KIND_LABEL } from './consent.types';
import type {
  ActiveConsentPolicies,
  ActiveConsentPolicy,
  ConsentKind,
  ConsentPolicyStatus,
  ConsentPolicyVersion,
  ConsentPolicyVersionList,
  CreateConsentPolicyPayload,
  OrganizationConsentStatus,
  UpdateConsentPolicyPayload,
} from './consent.types';

// The shape read back from `consent_policies` — declared rather than inferred
// so this file compiles before `prisma generate` has run against the new
// workflow columns.
interface ConsentPolicyRow {
  id: string;
  kind: ConsentKind;
  version: string;
  text: string;
  textAr: string | null;
  status: ConsentPolicyStatus;
  active: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedBy: string | null;
  updatedAt: Date;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNotes: string | null;
  publishedBy: string | null;
  publishedAt: Date | null;
}

// `consent_policies` is a global reference table (no RLS, plain SELECT grant
// — same as `roles`/`role_permissions`), so this reads via the bare
// PrismaService, no org context needed. Matches AuthRepository's own lookup
// of the active policy during signup.
@Injectable()
export class ConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * RIO-DATA-001 — the active version of one of the two consents. A missing
   * active policy is a 404 rather than a silent null: signup validates the
   * submitted version against this, so a misconfigured policy must fail
   * loudly at the point of misconfiguration, not let un-consented accounts
   * through.
   */
  async getActivePolicy(kind: ConsentKind): Promise<ActiveConsentPolicy> {
    // `status: 'published'` is redundant with `active` today — publish() is
    // the only writer of either — but it is the invariant signup actually
    // depends on ("never show text a System Reviewer hasn't signed off"), so
    // it is stated here rather than left implicit in another method.
    const policy = await this.prisma.consentPolicy.findFirst({
      where: { kind, active: true, status: 'published' },
      orderBy: { createdAt: 'desc' },
    });
    if (!policy) {
      throw new NotFoundException({
        error: {
          code: 'NO_ACTIVE_CONSENT_POLICY',
          message: `No active ${CONSENT_KIND_LABEL[kind]} consent policy is configured.`,
        },
      });
    }
    // Both languages travel together — the caller (public endpoint or signup
    // validation) picks one via consentPolicyTextFor. Serving a pre-resolved
    // single string would mean re-fetching on every language switch, and
    // would leave signup unable to check that the text it snapshots is the
    // text the browser rendered.
    return { kind, version: policy.version, text: policy.text, textAr: policy.textAr };
  }

  /**
   * The live citizen-consent notice, for the public survey screen.
   *
   * Deliberately its own call rather than a third field on
   * getActivePolicies(): that payload backs registration, and folding this in
   * would mean a missing citizen policy 404s signup — two unrelated flows
   * taken down by one misconfiguration.
   */
  getActiveCitizenPolicy(): Promise<ActiveConsentPolicy> {
    return this.getActivePolicy('citizen_consent');
  }

  /** Both consents in one round-trip — what the registration form needs. */
  async getActivePolicies(): Promise<ActiveConsentPolicies> {
    const [usePolicy, dataSharing] = await Promise.all([
      this.getActivePolicy('use_policy'),
      this.getActivePolicy('data_sharing'),
    ]);
    return { usePolicy, dataSharing };
  }

  // Read-only, for Organization Settings' Consent card — the org's own
  // consent record, meaning the NGO Admin's (account owner's) acceptance
  // specifically. NOT "whoever in this org accepted most recently": every
  // invited user (Research Officer, Reviewer, etc.) also accepts this same
  // policy as part of their own onboarding, and a naive "latest
  // ConsentAcceptance in the org" query would surface whichever of them
  // happened to onboard last, overwriting the admin's own acceptance in
  // this display even though nothing about the org's actual policy
  // acceptance changed.
  async getOrganizationStatus(): Promise<OrganizationConsentStatus> {
    const admin = await this.tenant.runInOrgContext((tx) =>
      tx.user.findFirst({
        where: { roleId: 'role_ngo_admin' },
        select: {
          name: true,
          email: true,
          consentedAt: true,
          consentedPolicyVersion: true,
          sharingConsentedAt: true,
          sharingConsentedPolicyVersion: true,
        },
      }),
    );
    // The two consents are reported independently — an org that registered
    // before the data-sharing consent existed shows the use policy as
    // accepted and the sharing consent as outstanding, which is the honest
    // state and the one the consent gate acts on.
    return {
      usePolicy: {
        version: admin?.consentedAt ? admin.consentedPolicyVersion : null,
        acceptedAt: admin?.consentedAt?.toISOString() ?? null,
      },
      dataSharing: {
        version: admin?.sharingConsentedAt ? admin.sharingConsentedPolicyVersion : null,
        acceptedAt: admin?.sharingConsentedAt?.toISOString() ?? null,
      },
      // Attributed to the account owner, same as before — null only when no
      // admin row exists at all, not merely when a consent is outstanding.
      acceptedByName: admin?.name ?? null,
      acceptedByEmail: admin?.email ?? null,
    };
  }

  // ───────────── Versioned policy administration (client-confirmed 2026-08-27)
  //
  // The client's answer to "hardcode each new version, or manage it
  // dynamically?" was: dynamic and versioned, System Admin drafts, System
  // Reviewer signs off before it goes live, full history retained, and each
  // user's consent stays tied to the version active when they gave it.
  //
  // Only the workflow below is new. The last of those four was already true —
  // ConsentAcceptance has always snapshotted the version, text and locale at
  // acceptance time, so a superseded version keeps its acceptances exactly as
  // given and is never silently upgraded.

  /**
   * Every version of both kinds, newest first — the whole Consent Policies
   * tab in one round-trip, drafts and superseded versions included. This is
   * the "full version history" the client asked to retain: a version has
   * always been its own row here, so nothing is overwritten and no separate
   * history table is needed (unlike MethodologyConfig, which is a single
   * mutable row and therefore needs MethodologyConfigHistory beside it).
   */
  async listVersions(): Promise<ConsentPolicyVersionList> {
    const rows = (await this.prisma.consentPolicy.findMany({
      orderBy: { createdAt: 'desc' },
    })) as unknown as ConsentPolicyRow[];
    const names = await this.resolveActorNames(rows);
    const view = (kind: ConsentKind): ConsentPolicyVersion[] =>
      rows.filter((r) => r.kind === kind).map((r) => this.toVersion(r, names));
    return {
      usePolicy: view('use_policy'),
      dataSharing: view('data_sharing'),
      citizenConsent: view('citizen_consent'),
    };
  }

  /**
   * System Admin drafts a new version. Deliberately a new row rather than an
   * edit of the live one: the currently-published text must keep rendering at
   * signup, unchanged, for as long as it takes the reviewer to sign the
   * successor off.
   */
  async createDraft(payload: CreateConsentPolicyPayload): Promise<ConsentPolicyVersion> {
    const actor = requireActor();
    const version = payload.version.trim();
    requireNonBlank(version, 'CONSENT_VERSION_REQUIRED', 'A version label is required.');
    requireNonBlank(payload.text, 'CONSENT_TEXT_REQUIRED', 'The policy text is required.');
    // Checked up front for a readable message; the (kind, version) unique
    // index is still the source of truth and is re-reported below, since two
    // admins can draft the same label concurrently.
    const clash = await this.prisma.consentPolicy.findFirst({
      where: { kind: payload.kind, version },
      select: { id: true },
    });
    if (clash) throw this.duplicateVersion(version);

    let row: ConsentPolicyRow;
    try {
      row = (await this.prisma.consentPolicy.create({
        data: {
          kind: payload.kind,
          version,
          text: payload.text,
          textAr: this.normalizeArabic(payload.textAr),
          status: 'draft',
          active: false,
          createdBy: actor,
          updatedBy: actor,
        },
      })) as unknown as ConsentPolicyRow;
    } catch (err) {
      if (this.isUniqueViolation(err)) throw this.duplicateVersion(version);
      throw err;
    }

    await this.audit.record({
      action: 'create',
      entityType: 'consent_policy',
      entityId: row.id,
      entityLabel: `${this.kindLabel(row.kind)} ${row.version} drafted`,
      // `before` is null throughout: this version did not exist a moment ago.
      // The text itself is deliberately not copied into the audit metadata —
      // it can run to tens of thousands of characters, and the row it points
      // at is immutable once published, so the entity id is a better
      // reference than a duplicate of the wording.
      changes: [
        { field: 'Version', before: null, after: row.version },
        { field: 'Status', before: null, after: 'draft' },
        {
          field: 'Arabic translation',
          before: null,
          after: row.textAr ? 'provided' : 'not provided',
        },
      ],
      metadata: { kind: row.kind, textLength: row.text.length },
    });
    return this.toVersion(row, await this.resolveActorNames([row]));
  }

  /**
   * Revise a version that has not gone live yet. A published version is
   * immutable — editing legal text under an acceptance already filed against
   * it would silently change what those users agreed to, which is the exact
   * failure the client's "consent record tied to the version active when they
   * consented" requirement rules out. Supersede it with a new draft instead.
   *
   * Editing something already approved (or awaiting review) invalidates that
   * review and returns it to draft: the reviewer signed off on wording, not
   * on a row id.
   */
  async updateDraft(
    id: string,
    payload: UpdateConsentPolicyPayload,
  ): Promise<ConsentPolicyVersion> {
    const actor = requireActor();
    const existing = await this.findVersionOrThrow(id);
    if (existing.status === 'published') {
      throw new ConflictException({
        error: {
          code: 'CONSENT_POLICY_PUBLISHED',
          message:
            'A published policy version can no longer be edited. Create a new version instead — existing consents stay tied to the version they were given against.',
        },
      });
    }

    const version = payload.version?.trim() ?? existing.version;
    if (payload.version !== undefined) {
      requireNonBlank(version, 'CONSENT_VERSION_REQUIRED', 'A version label is required.');
      if (version !== existing.version) {
        const clash = await this.prisma.consentPolicy.findFirst({
          where: { kind: existing.kind, version },
          select: { id: true },
        });
        if (clash) throw this.duplicateVersion(version);
      }
    }
    const text = payload.text ?? existing.text;
    if (payload.text !== undefined) {
      requireNonBlank(text, 'CONSENT_TEXT_REQUIRED', 'The policy text is required.');
    }
    const textAr =
      payload.textAr === undefined ? existing.textAr : this.normalizeArabic(payload.textAr);

    let row: ConsentPolicyRow;
    try {
      row = (await this.prisma.consentPolicy.update({
        where: { id },
        data: {
          version,
          text,
          textAr,
          // Any content change re-opens the gate, exactly as
          // MethodologyConfigService.update() does.
          status: 'draft',
          reviewedBy: null,
          reviewedAt: null,
          reviewNotes: null,
          updatedBy: actor,
        },
      })) as unknown as ConsentPolicyRow;
    } catch (err) {
      if (this.isUniqueViolation(err)) throw this.duplicateVersion(version);
      throw err;
    }

    const changes: AuditChange[] = [];
    if (row.version !== existing.version) {
      changes.push({ field: 'Version', before: existing.version, after: row.version });
    }
    if (row.text !== existing.text) {
      // Lengths rather than bodies — see the note in createDraft().
      changes.push({
        field: 'Policy text',
        before: `${existing.text.length} characters`,
        after: `${row.text.length} characters`,
      });
    }
    if (row.textAr !== existing.textAr) {
      changes.push({
        field: 'Arabic translation',
        before: existing.textAr ? `${existing.textAr.length} characters` : 'not provided',
        after: row.textAr ? `${row.textAr.length} characters` : 'not provided',
      });
    }
    if (row.status !== existing.status) {
      changes.push({ field: 'Status', before: existing.status, after: row.status });
    }
    await this.audit.record({
      action: 'edit',
      entityType: 'consent_policy',
      entityId: row.id,
      entityLabel: `${this.kindLabel(row.kind)} ${row.version} edited`,
      // Never empty: a no-op PATCH still records that someone touched the
      // draft, which is itself the auditable fact.
      changes:
        changes.length > 0
          ? changes
          : [{ field: 'Policy text', before: 'unchanged', after: 'unchanged' }],
      metadata: { kind: row.kind, status: row.status },
    });
    return this.toVersion(row, await this.resolveActorNames([row]));
  }

  /** System Admin hands the draft to the System Reviewer. */
  async submitForApproval(id: string): Promise<ConsentPolicyVersion> {
    const actor = requireActor();
    const existing = await this.findVersionOrThrow(id);
    if (existing.status !== 'draft') {
      throw new ConflictException({
        error: {
          code: 'CONSENT_POLICY_NOT_DRAFT',
          message: 'Only a draft version can be submitted for approval.',
        },
      });
    }
    const row = (await this.prisma.consentPolicy.update({
      where: { id },
      data: { status: 'pending_approval', updatedBy: actor },
    })) as unknown as ConsentPolicyRow;

    await this.audit.record({
      action: 'edit',
      entityType: 'consent_policy',
      entityId: row.id,
      entityLabel: `${this.kindLabel(row.kind)} ${row.version} submitted for approval`,
      changes: [{ field: 'Status', before: 'draft', after: 'pending_approval' }],
      metadata: { kind: row.kind, step: 'submit' },
    });
    return this.toVersion(row, await this.resolveActorNames([row]));
  }

  /**
   * System Reviewer's sign-off. Notes are mandatory on both outcomes, same as
   * every other governance gate on the platform (survey, NCNP report,
   * methodology config) — the client asked for this one to be "consistent
   * with how we've treated other governance-level decisions".
   */
  async approveVersion(id: string, notes: string): Promise<ConsentPolicyVersion> {
    return this.review(id, 'approved', notes);
  }

  /** Sends it back to the System Admin to revise and resubmit. */
  async rejectVersion(id: string, notes: string): Promise<ConsentPolicyVersion> {
    return this.review(id, 'draft', notes);
  }

  /**
   * Goes live at signup. The previously-active version of the same kind is
   * deactivated in the same transaction — never deleted and never rewritten:
   * it stays `published` with its acceptances intact, which is what makes
   * "the previously active version stays valid for anyone who consented under
   * it" true rather than aspirational.
   */
  async publishVersion(id: string): Promise<ConsentPolicyVersion> {
    const actor = requireActor();
    const existing = await this.findVersionOrThrow(id);
    if (existing.status !== 'approved') {
      throw new ConflictException({
        error: {
          code: 'CONSENT_POLICY_NOT_APPROVED',
          message:
            'This version must be approved by a System Reviewer before it can be published.',
        },
      });
    }
    const superseded = (await this.prisma.consentPolicy.findFirst({
      where: { kind: existing.kind, active: true },
      select: { id: true, version: true },
    })) as { id: string; version: string } | null;

    // One transaction: a window in which both versions are active (or neither
    // is) would let two registrants consent to different wording under the
    // same "current" policy, and signup's stale-version check would reject
    // whichever one lost the race.
    const [row] = await this.prisma.$transaction([
      this.prisma.consentPolicy.update({
        where: { id },
        data: {
          status: 'published',
          active: true,
          publishedBy: actor,
          publishedAt: new Date(),
          updatedBy: actor,
        },
      }),
      ...(superseded && superseded.id !== id
        ? [
            this.prisma.consentPolicy.update({
              where: { id: superseded.id },
              data: { active: false },
            }),
          ]
        : []),
    ]);
    const published = row as unknown as ConsentPolicyRow;

    await this.audit.record({
      action: 'approve',
      entityType: 'consent_policy',
      entityId: published.id,
      entityLabel: `${this.kindLabel(published.kind)} ${published.version} published`,
      changes: [
        { field: 'Status', before: 'approved', after: 'published' },
        {
          field: 'Active version',
          before: superseded?.version ?? null,
          after: published.version,
        },
      ],
      metadata: {
        kind: published.kind,
        step: 'publish',
        supersededVersion: superseded?.version ?? null,
      },
    });
    return this.toVersion(published, await this.resolveActorNames([published]));
  }

  private async review(
    id: string,
    outcome: 'approved' | 'draft',
    notes: string,
  ): Promise<ConsentPolicyVersion> {
    requireNonBlank(notes, 'REVIEWER_NOTES_REQUIRED', 'Reviewer notes are required.');
    const reviewer = requireActor();
    const existing = await this.findVersionOrThrow(id);
    if (existing.status !== 'pending_approval') {
      throw new ConflictException({
        error: {
          code: 'CONSENT_POLICY_NOT_PENDING_APPROVAL',
          message: 'This version is not currently awaiting approval.',
        },
      });
    }
    const row = (await this.prisma.consentPolicy.update({
      where: { id },
      data: { status: outcome, reviewedBy: reviewer, reviewedAt: new Date(), reviewNotes: notes },
    })) as unknown as ConsentPolicyRow;

    const rejected = outcome === 'draft';
    await this.audit.record({
      // Both outcomes file under `approve` with a distinguishing label, the
      // same convention NcnpReportReviewService uses — the audit vocabulary
      // treats a review decision as one action with two verdicts.
      action: 'approve',
      entityType: 'consent_policy',
      entityId: row.id,
      entityLabel: `${this.kindLabel(row.kind)} ${row.version} ${rejected ? 'rejected' : 'approved'}`,
      changes: [
        { field: 'Status', before: 'pending_approval', after: row.status },
        { field: 'Reviewer Notes', before: null, after: notes },
      ],
      metadata: { kind: row.kind, status: row.status },
    });
    return this.toVersion(row, await this.resolveActorNames([row]));
  }

  private async findVersionOrThrow(id: string): Promise<ConsentPolicyRow> {
    const row = await this.prisma.consentPolicy.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({
        error: {
          code: 'CONSENT_POLICY_NOT_FOUND',
          message: 'That policy version no longer exists.',
        },
      });
    }
    return row as unknown as ConsentPolicyRow;
  }

  private duplicateVersion(version: string): ConflictException {
    return new ConflictException({
      error: {
        code: 'CONSENT_VERSION_EXISTS',
        message: `Version "${version}" already exists for this policy. Choose a different label.`,
      },
    });
  }

  private isUniqueViolation(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
  }

  // An empty textarea means "no Arabic copy yet", not an empty Arabic policy —
  // storing '' would make consentPolicyTextFor() fall through to English
  // anyway, but would report the translation as present on the admin screen.
  private normalizeArabic(value: string | null | undefined): string | null {
    if (value === undefined || value === null) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private kindLabel(kind: ConsentKind): string {
    return CONSENT_KIND_LABEL[kind];
  }

  // `users` is RLS-scoped per org and consent_policies is global reference
  // data with no ambient org context, so actor names resolve through the same
  // SELECT-only cross-org supervisor path MethodologyConfigService uses.
  // Batched over the whole list: the admin tab renders up to four actors per
  // row, and a per-field lookup would be O(rows × 4) round-trips.
  private async resolveActorNames(rows: ConsentPolicyRow[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rows
          .flatMap((r) => [r.createdBy, r.updatedBy, r.reviewedBy, r.publishedBy])
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    if (ids.length === 0) return new Map();
    const users = await this.tenant.runAsSupervisor((tx) =>
      tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    );
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private toVersion(row: ConsentPolicyRow, names: Map<string, string>): ConsentPolicyVersion {
    const name = (id: string | null): string | null => (id ? (names.get(id) ?? null) : null);
    return {
      id: row.id,
      kind: row.kind,
      version: row.version,
      text: row.text,
      textAr: row.textAr,
      status: row.status,
      active: row.active,
      createdByName: name(row.createdBy),
      createdAt: row.createdAt.toISOString(),
      updatedByName: name(row.updatedBy),
      updatedAt: row.updatedAt.toISOString(),
      reviewedByName: name(row.reviewedBy),
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      reviewNotes: row.reviewNotes,
      publishedByName: name(row.publishedBy),
      publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    };
  }
}

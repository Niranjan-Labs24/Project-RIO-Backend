import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantPrismaService } from "../../tenancy/tenant-prisma.service";
import { getOrgStore, requireActor, requireOrgId } from "../../tenancy/org-context";
import { roleByKey } from "../../rbac/role-matrix";
import { AuditService } from "../audit/audit.service";
import type {
  CreateSharingRequestPayload, OrgLookupResult, SharedStudySnapshot, SharingRequest, SharingRequestRow,
  StudyLookupResult,
} from "./sharing.types";

// sharing_requests has no RLS (see the SharingRequest model comment in
// schema.prisma) — a request is inherently visible to both the owning and
// requesting orgs, plus the cross-entity Center Supervisor. Authorization
// is enforced here instead of at the DB layer.
@Injectable()
export class SharingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
    private readonly audit: AuditService,
  ) {}

  private isCrossEntity(): boolean {
    const role = getOrgStore()?.role;
    return role !== undefined && roleByKey(role)?.crossEntity === true;
  }

  async create(payload: CreateSharingRequestPayload): Promise<SharingRequest> {
    const requestingOrgId = requireOrgId();
    const requestedBy = requireActor();
    if (payload.ownerOrgId === requestingOrgId) {
      throw new BadRequestException({
        error: { code: "CANNOT_REQUEST_OWN_STUDY", message: "You already own this study." },
      });
    }

    // Cross-org existence + ownership check — the study must actually
    // belong to the org being asked, via the same SELECT-only supervisor
    // path the citizen flow uses to resolve cross-org rows.
    const study = await this.tenant.runAsSupervisor((tx) => tx.study.findUnique({ where: { id: payload.studyId } }));
    if (!study || study.orgId !== payload.ownerOrgId) {
      throw new NotFoundException({ error: { code: "STUDY_NOT_FOUND", message: "Study not found" } });
    }

    const row = await this.prisma.sharingRequest.create({
      data: {
        ownerOrgId: payload.ownerOrgId,
        requestingOrgId,
        studyId: payload.studyId,
        requestedBy,
        note: payload.note ?? null,
      },
    });
    await this.audit.record({
      action: "create",
      entityType: "sharing_request",
      entityId: row.id,
      entityLabel: `Sharing request for study ${payload.studyId}`,
      organizationId: requestingOrgId,
    });
    return this.enrichOne(row as unknown as SharingRequestRow);
  }

  async list(): Promise<SharingRequest[]> {
    const orgId = requireOrgId();
    const rows = this.isCrossEntity()
      ? await this.prisma.sharingRequest.findMany({ orderBy: { requestedAt: "desc" } })
      : await this.prisma.sharingRequest.findMany({
          where: { OR: [{ ownerOrgId: orgId }, { requestingOrgId: orgId }] },
          orderBy: { requestedAt: "desc" },
        });
    return this.enrichMany(rows as unknown as SharingRequestRow[]);
  }

  async getById(id: string): Promise<SharingRequest> {
    const row = await this.findVisibleOrThrow(id);
    return this.enrichOne(row);
  }

  async approve(id: string): Promise<SharingRequest> {
    return this.decide(id, "approved");
  }

  async reject(id: string): Promise<SharingRequest> {
    return this.decide(id, "rejected");
  }

  async getSharedSnapshot(id: string): Promise<SharedStudySnapshot> {
    const row = await this.findVisibleOrThrow(id);
    const orgId = requireOrgId();
    if (row.status !== "approved") {
      throw new ForbiddenException({
        error: { code: "SHARING_NOT_APPROVED", message: "This sharing request has not been approved." },
      });
    }
    if (!this.isCrossEntity() && row.requestingOrgId !== orgId) {
      throw new ForbiddenException({
        error: { code: "FORBIDDEN", message: "Only the requesting organisation can view the shared study." },
      });
    }

    return this.tenant.runAsSupervisor(async (tx) => {
      const study = await tx.study.findUnique({ where: { id: row.studyId } });
      if (!study) throw new NotFoundException({ error: { code: "STUDY_NOT_FOUND", message: "Study not found" } });
      const need = await tx.need.findUnique({ where: { studyId: row.studyId } });
      const evidenceCount = await tx.evidence.count({ where: { studyId: row.studyId } });
      return {
        studyId: study.id,
        title: study.title,
        status: study.status,
        needStatement: need?.statement ?? null,
        needVillages: need?.village ?? [],
        evidenceCount,
      };
    });
  }

  // Organizations searchable for a new sharing request — name-only, active
  // orgs, excluding the caller's own (you can't request your own study).
  // `organisations` is RLS-scoped per org (see the isolation policy in the
  // rls_domain migration) — a bare PrismaService read here would silently
  // return nothing for every other org, so this goes through the same
  // SELECT-only supervisor path as the cross-org study lookups.
  async lookupOrganizations(query: string | undefined): Promise<OrgLookupResult[]> {
    const orgId = requireOrgId();
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.organisation.findMany({
        where: {
          id: { not: orgId },
          isActive: true,
          ...(query ? { name: { contains: query, mode: "insensitive" } } : {}),
        },
        orderBy: { name: "asc" },
        take: 20,
      }),
    );
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }

  // Completed (human_reviewed) studies for a given org — the only ones
  // eligible to be requested for sharing. Study is RLS-scoped per org, so a
  // cross-org read has to go through the same SELECT-only supervisor path
  // used elsewhere for cross-org lookups.
  async lookupStudiesForOrg(ownerOrgId: string): Promise<StudyLookupResult[]> {
    const rows = await this.tenant.runAsSupervisor((tx) =>
      tx.study.findMany({
        where: { orgId: ownerOrgId, status: "human_reviewed" },
        orderBy: { updatedAt: "desc" },
      }),
    );
    return rows.map((r) => ({ id: r.id, title: r.title }));
  }

  private async decide(id: string, status: "approved" | "rejected"): Promise<SharingRequest> {
    const orgId = requireOrgId();
    const decidedBy = requireActor();
    const existing = await this.prisma.sharingRequest.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({ error: { code: "SHARING_REQUEST_NOT_FOUND", message: "Sharing request not found" } });
    }
    if (existing.ownerOrgId !== orgId) {
      throw new ForbiddenException({
        error: { code: "FORBIDDEN", message: "Only the owning organisation can decide this request." },
      });
    }
    if (existing.status !== "pending") {
      throw new BadRequestException({
        error: { code: "SHARING_REQUEST_ALREADY_DECIDED", message: "This request has already been decided." },
      });
    }

    const row = await this.prisma.sharingRequest.update({
      where: { id },
      data: { status, decidedBy, decidedAt: new Date() },
    });
    await this.audit.record({
      action: status === "approved" ? "approve" : "edit",
      entityType: "sharing_request",
      entityId: row.id,
      entityLabel: `Sharing request for study ${row.studyId}`,
      organizationId: orgId,
    });
    return this.enrichOne(row as unknown as SharingRequestRow);
  }

  private async findVisibleOrThrow(id: string): Promise<SharingRequestRow> {
    const orgId = requireOrgId();
    const row = await this.prisma.sharingRequest.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException({ error: { code: "SHARING_REQUEST_NOT_FOUND", message: "Sharing request not found" } });
    }
    const visible = this.isCrossEntity() || row.ownerOrgId === orgId || row.requestingOrgId === orgId;
    if (!visible) {
      throw new NotFoundException({ error: { code: "SHARING_REQUEST_NOT_FOUND", message: "Sharing request not found" } });
    }
    return row as unknown as SharingRequestRow;
  }

  private async enrichOne(row: SharingRequestRow): Promise<SharingRequest> {
    const [enriched] = await this.enrichMany([row]);
    return enriched as SharingRequest;
  }

  // Batched to avoid N+1 org/study lookups when rendering the list — one
  // supervisor read for all studies involved, one for all orgs involved.
  private async enrichMany(rows: SharingRequestRow[]): Promise<SharingRequest[]> {
    const studyIds = Array.from(new Set(rows.map((r) => r.studyId)));
    const orgIds = Array.from(new Set(rows.flatMap((r) => [r.ownerOrgId, r.requestingOrgId])));

    const [studies, orgs] = await Promise.all([
      studyIds.length === 0
        ? Promise.resolve([])
        : this.tenant.runAsSupervisor((tx) => tx.study.findMany({ where: { id: { in: studyIds } } })),
      orgIds.length === 0
        ? Promise.resolve([])
        : this.tenant.runAsSupervisor((tx) => tx.organisation.findMany({ where: { id: { in: orgIds } } })),
    ]);
    const studyById = new Map(studies.map((s) => [s.id, s]));
    const orgById = new Map(orgs.map((o) => [o.id, o]));

    return rows.map((row) => ({
      id: row.id,
      ownerOrgId: row.ownerOrgId,
      ownerOrgName: orgById.get(row.ownerOrgId)?.name ?? row.ownerOrgId,
      requestingOrgId: row.requestingOrgId,
      requestingOrgName: orgById.get(row.requestingOrgId)?.name ?? row.requestingOrgId,
      studyId: row.studyId,
      studyTitle: studyById.get(row.studyId)?.title ?? row.studyId,
      status: row.status,
      requestedBy: row.requestedBy,
      requestedAt: row.requestedAt.toISOString(),
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      note: row.note,
    }));
  }
}

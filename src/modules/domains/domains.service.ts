import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  CreateDomainPayload, CreateSubDomainPayload, Domain, DomainRow, DomainWithSubDomains, PublicDomainOption, PublicDomainStats, PublicDomainTreeOption, SubDomain, SubDomainRow,
  UpdateDomainPayload, UpdateSubDomainPayload,
} from './domains.types';

// `domains`/`sub_domains` are global reference tables (no org_id, no RLS —
// same as `roles`/`consent_policies`), so this reads/writes via the bare
// PrismaService, no org context needed. Rows are deactivated (isActive:
// false) rather than deleted, matching the migration's grant (no DELETE).
@Injectable()
export class DomainsService {
  constructor(private readonly prisma: PrismaService) {}

  async listDomains(): Promise<Domain[]> {
    const rows = await this.prisma.domain.findMany({ orderBy: { displayOrder: 'asc' } });
    return rows.map((r) => this.toDomain(r));
  }

  // Active domain names only, reachable pre-login — backs the sector
  // dropdown on the public signup form (see DomainsController's `/public`
  // route, which carries no @RequirePermission).
  async listActiveNames(): Promise<PublicDomainOption[]> {
    const rows = await this.prisma.domain.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: 'asc' },
      select: { name: true, nameAr: true },
    });
    return rows;
  }

  // Active domain/sub-domain names + Arabic names only, gated by
  // authentication alone (no `methodologyQuestionBank` grant required) — see
  // PublicDomainTreeOption's own comment for why this exists as a second
  // route alongside the `methodologyQuestionBank`-gated `/tree`.
  async listActiveTree(): Promise<PublicDomainTreeOption[]> {
    const rows = await this.prisma.domain.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: 'asc' },
      select: {
        name: true,
        nameAr: true,
        subDomains: {
          where: { isActive: true },
          orderBy: { displayOrder: 'asc' },
          select: { name: true, nameAr: true },
        },
      },
    });
    return rows;
  }

  /**
   * Per-domain counts of the published question bank, for the public /home
   * page. Counts only: no question text, wording, codes or weights leave
   * here. A question is matched to a domain by name (trimmed, any case) -
   * the bank stores the domain name, not an id. Questions that match no
   * active domain are the cross-domain patterns and are counted apart.
   */
  async publicStats(): Promise<PublicDomainStats> {
    const [domains, version] = await Promise.all([
      this.prisma.domain.findMany({
        where: { isActive: true },
        orderBy: { displayOrder: 'asc' },
        select: { code: true, name: true, nameAr: true },
      }),
      this.prisma.methodologyVersion.findFirst({
        where: { status: 'PUBLISHED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, version: true },
      }),
    ]);
    const questions = version
      ? await this.prisma.question.findMany({
          where: { methodologyVersionId: version.id, usedInMvp: true },
          select: { domain: true, subDomain: true, indicator: true, kpi: true },
        })
      : [];

    const key = (s: string) => s.trim().toLowerCase();
    const byDomain = new Map(
      domains.map((d) => [
        key(d.name),
        { subs: new Set<string>(), inds: new Set<string>(), kpis: new Set<string>(), questions: 0 },
      ]),
    );
    // Only the bank's own cross-domain patterns count as cross-domain. A
    // question whose domain was renamed or deactivated matches nothing and
    // is left out, rather than silently swelling the cross-domain figure.
    let crossDomainQuestions = 0;
    let counted = 0;
    for (const q of questions) {
      const bucket = byDomain.get(key(q.domain));
      if (!bucket) {
        if (key(q.domain).startsWith('cross-domain')) {
          crossDomainQuestions += 1;
          counted += 1;
        }
        continue;
      }
      counted += 1;
      bucket.questions += 1;
      bucket.subs.add(key(q.subDomain));
      if (q.indicator) bucket.inds.add(key(q.indicator));
      if (q.kpi) bucket.kpis.add(key(q.kpi));
    }

    const rows = domains.map((d) => {
      const b = byDomain.get(key(d.name))!;
      return {
        code: d.code,
        name: d.name,
        nameAr: d.nameAr,
        subDomains: b.subs.size,
        indicators: b.inds.size,
        kpis: b.kpis.size,
        questions: b.questions,
      };
    });
    const sum = (k: 'subDomains' | 'indicators' | 'kpis' | 'questions') =>
      rows.reduce((n, r) => n + r[k], 0);
    return {
      // The short version ("v5.0"), not the stored label ("v5.0 - Approved
      // methodology baseline"): a public page needs the number, not the wording.
      methodologyVersion: version ? (version.version.split(/\s+-\s+/)[0] ?? version.version).trim() : null,
      domains: rows,
      totals: {
        domains: rows.length,
        subDomains: sum('subDomains'),
        indicators: sum('indicators'),
        kpis: sum('kpis'),
        questions: counted,
        domainQuestions: sum('questions'),
        crossDomainQuestions,
      },
    };
  }

  async createDomain(payload: CreateDomainPayload): Promise<Domain> {
    try {
      const row = await this.prisma.domain.create({
        data: {
          code: payload.code,
          name: payload.name,
          nameAr: payload.nameAr,
          displayOrder: payload.displayOrder ?? 0,
        },
      });
      return this.toDomain(row);
    } catch (err) {
      throw this.mapConflict(err, 'DOMAIN_CODE_ALREADY_EXISTS', 'A domain with this code already exists.');
    }
  }

  async updateDomain(id: string, patch: UpdateDomainPayload): Promise<Domain> {
    await this.findDomainOrThrow(id);
    try {
      const row = await this.prisma.domain.update({ where: { id }, data: patch });
      return this.toDomain(row);
    } catch (err) {
      throw this.mapConflict(err, 'DOMAIN_CODE_ALREADY_EXISTS', 'A domain with this code already exists.');
    }
  }

  // Deactivating a domain cascades to deactivate its sub-domains too — an
  // active sub-domain under an inactive domain would be a genuinely
  // inconsistent state (AI Classification's domain dropdown would offer a
  // sub-domain whose parent it no longer shows). This is deliberately
  // one-way: reactivating the domain does NOT reactivate its sub-domains,
  // so nothing "comes back" without a reviewer explicitly deciding it should.
  async setDomainActive(id: string, isActive: boolean): Promise<Domain> {
    await this.findDomainOrThrow(id);
    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.domain.update({ where: { id }, data: { isActive } });
      if (!isActive) {
        await tx.subDomain.updateMany({ where: { domainId: id, isActive: true }, data: { isActive: false } });
      }
      return updated;
    });
    return this.toDomain(row);
  }

  // One query (a single JOIN via Prisma's `include`), not one query per
  // domain — the AI Classification override modal and Survey Builder both
  // need every active domain's active sub-domains up front, and used to get
  // that by calling listDomains() then listSubDomains() once per domain
  // (an N+1 pattern: ~10 HTTP round trips for 9 active domains). Callers
  // should use this instead of that loop.
  async listDomainsWithSubDomains(): Promise<DomainWithSubDomains[]> {
    const rows = await this.prisma.domain.findMany({
      orderBy: { displayOrder: 'asc' },
      include: { subDomains: { orderBy: { displayOrder: 'asc' } } },
    });
    return rows.map((r) => ({
      ...this.toDomain(r),
      subDomains: r.subDomains.map((sd) => this.toSubDomain(sd)),
    }));
  }

  async listSubDomains(domainId: string): Promise<SubDomain[]> {
    await this.findDomainOrThrow(domainId);
    const rows = await this.prisma.subDomain.findMany({ where: { domainId }, orderBy: { displayOrder: 'asc' } });
    return rows.map((r) => this.toSubDomain(r));
  }

  async createSubDomain(domainId: string, payload: CreateSubDomainPayload): Promise<SubDomain> {
    await this.findDomainOrThrow(domainId);
    try {
      const row = await this.prisma.subDomain.create({
        data: {
          domainId,
          code: payload.code,
          name: payload.name,
          nameAr: payload.nameAr,
          displayOrder: payload.displayOrder ?? 0,
        },
      });
      return this.toSubDomain(row);
    } catch (err) {
      throw this.mapConflict(err, 'SUBDOMAIN_CODE_ALREADY_EXISTS', 'A sub-domain with this code already exists.');
    }
  }

  async updateSubDomain(domainId: string, id: string, patch: UpdateSubDomainPayload): Promise<SubDomain> {
    await this.findSubDomainOrThrow(domainId, id);
    try {
      const row = await this.prisma.subDomain.update({ where: { id }, data: patch });
      return this.toSubDomain(row);
    } catch (err) {
      throw this.mapConflict(err, 'SUBDOMAIN_CODE_ALREADY_EXISTS', 'A sub-domain with this code already exists.');
    }
  }

  async setSubDomainActive(domainId: string, id: string, isActive: boolean): Promise<SubDomain> {
    await this.findSubDomainOrThrow(domainId, id);
    if (isActive) {
      const domain = await this.findDomainOrThrow(domainId);
      if (!domain.isActive) {
        throw new ConflictException({
          error: { code: 'PARENT_DOMAIN_INACTIVE', message: 'Reactivate the parent domain before reactivating this sub-domain.' },
        });
      }
    }
    const row = await this.prisma.subDomain.update({ where: { id }, data: { isActive } });
    return this.toSubDomain(row);
  }

  private async findDomainOrThrow(id: string): Promise<DomainRow> {
    const row = await this.prisma.domain.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ error: { code: 'DOMAIN_NOT_FOUND', message: 'Domain not found' } });
    return row;
  }

  private async findSubDomainOrThrow(domainId: string, id: string): Promise<SubDomainRow> {
    const row = await this.prisma.subDomain.findUnique({ where: { id } });
    if (!row || row.domainId !== domainId) {
      throw new NotFoundException({ error: { code: 'SUBDOMAIN_NOT_FOUND', message: 'Sub-domain not found' } });
    }
    return row;
  }

  private mapConflict(err: unknown, code: string, message: string): unknown {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return new ConflictException({ error: { code, message } });
    }
    return err;
  }

  private toDomain(row: DomainRow): Domain {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      nameAr: row.nameAr,
      displayOrder: row.displayOrder,
      isActive: row.isActive,
    };
  }

  private toSubDomain(row: SubDomainRow): SubDomain {
    return {
      id: row.id,
      domainId: row.domainId,
      code: row.code,
      name: row.name,
      nameAr: row.nameAr,
      displayOrder: row.displayOrder,
      isActive: row.isActive,
    };
  }
}

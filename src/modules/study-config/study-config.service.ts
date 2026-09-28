import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import type {
  CreateStudyConfigOptionPayload, StudyConfigOption, StudyConfigOptionRow, UpdateStudyConfigOptionPayload,
} from './study-config.types';

// `study_type_options`/`target_sector_options` are global reference tables
// (no org_id, no RLS — same pattern as domains/sub_domains), populated from
// Methodology Configuration per Sprint 2 clarification Q3/Q4 ("should be
// configurable... rather than hardcoded"). The actual value list is still
// pending client confirmation (Q35 follow-up) — both tables start empty;
// a System Admin can add real values here today, and swap in the client's
// final list once it lands, without any further schema change.
//
// Study.studyType/targetSector stay plain strings validated against these
// tables' `name` at the API layer (see StudiesService), not a foreign key —
// same reasoning as Domain/SubDomain's `code`: renaming or retiring an
// option here must never require a migration touching every Study row that
// already used the old wording.
@Injectable()
export class StudyConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listStudyTypes(): Promise<StudyConfigOption[]> {
    const rows = await this.prisma.studyTypeOption.findMany({ orderBy: { displayOrder: 'asc' } });
    return rows.map((r) => this.toOption(r));
  }

  async listActiveStudyTypeNames(): Promise<string[]> {
    const rows = await this.prisma.studyTypeOption.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: 'asc' },
      select: { name: true },
    });
    return rows.map((r) => r.name);
  }

  // RIO-FR-003 AC 6 — the closed vocabulary the theme extractor picks from.
  // Rides the same option CRUD as Study Types above, so Methodology
  // Configuration gets a Need Themes card with no new plumbing.
  async listNeedThemes(): Promise<StudyConfigOption[]> {
    const rows = await this.prisma.needThemeOption.findMany({ orderBy: { displayOrder: 'asc' } });
    return rows.map((r) => this.toOption(r));
  }

  async listActiveNeedThemeNames(): Promise<string[]> {
    const rows = await this.prisma.needThemeOption.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: 'asc' },
      select: { name: true },
    });
    return rows.map((r) => r.name);
  }

  async createNeedTheme(payload: CreateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    return this.toOption(await this.createOption(this.prisma.needThemeOption, payload, 'Need Theme'));
  }

  async updateNeedTheme(id: string, payload: UpdateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    return this.toOption(await this.updateOption(this.prisma.needThemeOption, id, payload, 'Need Theme'));
  }

  async setNeedThemeActive(id: string, isActive: boolean): Promise<StudyConfigOption> {
    return this.toOption(await this.setActive(this.prisma.needThemeOption, id, isActive, 'Need Theme'));
  }

  async createStudyType(payload: CreateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    const row = await this.createOption(this.prisma.studyTypeOption, payload, 'Study Type');
    return this.toOption(row);
  }

  async updateStudyType(id: string, payload: UpdateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    const row = await this.updateOption(this.prisma.studyTypeOption, id, payload, 'Study Type');
    return this.toOption(row);
  }

  async setStudyTypeActive(id: string, isActive: boolean): Promise<StudyConfigOption> {
    const row = await this.setActive(this.prisma.studyTypeOption, id, isActive, 'Study Type');
    return this.toOption(row);
  }

  async listTargetSectors(): Promise<StudyConfigOption[]> {
    const rows = await this.prisma.targetSectorOption.findMany({ orderBy: { displayOrder: 'asc' } });
    return rows.map((r) => this.toOption(r));
  }

  async listActiveTargetSectorNames(): Promise<string[]> {
    const rows = await this.prisma.targetSectorOption.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: 'asc' },
      select: { name: true },
    });
    return rows.map((r) => r.name);
  }

  async createTargetSector(payload: CreateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    const row = await this.createOption(this.prisma.targetSectorOption, payload, 'Target Sector');
    return this.toOption(row);
  }

  async updateTargetSector(id: string, payload: UpdateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    const row = await this.updateOption(this.prisma.targetSectorOption, id, payload, 'Target Sector');
    return this.toOption(row);
  }

  async setTargetSectorActive(id: string, isActive: boolean): Promise<StudyConfigOption> {
    const row = await this.setActive(this.prisma.targetSectorOption, id, isActive, 'Target Sector');
    return this.toOption(row);
  }

  // RIO-FR-005 (Q10) — Decision Types, same configurable-list shape and
  // reasoning as Study Type/Target Sector above, just a different table.
  // Lives here rather than a fourth near-identical service.
  async listDecisionTypes(): Promise<StudyConfigOption[]> {
    const rows = await this.prisma.decisionTypeOption.findMany({ orderBy: { displayOrder: 'asc' } });
    return rows.map((r) => this.toOption(r));
  }

  async listActiveDecisionTypeNames(): Promise<string[]> {
    const rows = await this.prisma.decisionTypeOption.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: 'asc' },
      select: { name: true },
    });
    return rows.map((r) => r.name);
  }

  async createDecisionType(payload: CreateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    const row = await this.createOption(this.prisma.decisionTypeOption, payload, 'Decision Type');
    return this.toOption(row);
  }

  async updateDecisionType(id: string, payload: UpdateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    const row = await this.updateOption(this.prisma.decisionTypeOption, id, payload, 'Decision Type');
    return this.toOption(row);
  }

  async setDecisionTypeActive(id: string, isActive: boolean): Promise<StudyConfigOption> {
    const row = await this.setActive(this.prisma.decisionTypeOption, id, isActive, 'Decision Type');
    return this.toOption(row);
  }

  // Gap Types — client correction (2026-08-27) superseding RIO-FR-005 Q12's
  // "five fixed values, final, no additions". Same configurable-list shape
  // as Study Type/Target Sector/Decision Type above.
  async listGapTypes(): Promise<StudyConfigOption[]> {
    const rows = await this.prisma.gapTypeOption.findMany({ orderBy: { displayOrder: 'asc' } });
    return rows.map((r) => this.toOption(r));
  }

  async listActiveGapTypeNames(): Promise<string[]> {
    const rows = await this.prisma.gapTypeOption.findMany({
      where: { isActive: true },
      orderBy: { displayOrder: 'asc' },
      select: { name: true },
    });
    return rows.map((r) => r.name);
  }

  async createGapType(payload: CreateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    const row = await this.createOption(this.prisma.gapTypeOption, payload, 'Gap Type');
    return this.toOption(row);
  }

  async updateGapType(id: string, payload: UpdateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    const row = await this.updateOption(this.prisma.gapTypeOption, id, payload, 'Gap Type');
    return this.toOption(row);
  }

  async setGapTypeActive(id: string, isActive: boolean): Promise<StudyConfigOption> {
    const row = await this.setActive(this.prisma.gapTypeOption, id, isActive, 'Gap Type');
    return this.toOption(row);
  }

  // Shared CRUD body for both option tables — identical shape (id, name,
  // displayOrder, isActive), so one implementation parametrized on the
  // Prisma delegate avoids maintaining two copies of the same try/catch and
  // not-found handling. `kind` (e.g. "Gap Type") labels the audit entry so an
  // auditor reading the log can tell which of the five configurable lists
  // changed without cross-referencing the raw entity id.
  //
  // RIO-NFR-014 (28 Sep 2026) — these five configurable lists (need themes,
  // study types, target sectors, decision types, gap types) had NO audit
  // trail at all before this. Since all of them funnel through these three
  // helpers, adding `this.audit.record(...)` here covers every one of the 15
  // public create/update/activate methods above in one place.
  private async createOption(
    delegate: {
      create: (args: {
        data: { name: string; nameAr?: string; displayOrder?: number };
      }) => Promise<StudyConfigOptionRow>;
    },
    payload: CreateStudyConfigOptionPayload,
    kind: string,
  ): Promise<StudyConfigOptionRow> {
    let row: StudyConfigOptionRow;
    try {
      row = await delegate.create({
        data: { name: payload.name, nameAr: payload.nameAr, displayOrder: payload.displayOrder },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          error: { code: 'OPTION_NAME_TAKEN', message: `"${payload.name}" already exists.` },
        });
      }
      throw err;
    }
    await this.audit.record({
      action: 'create',
      entityType: 'study_config_option',
      entityId: row.id,
      entityLabel: `${kind}: ${row.name}`,
      metadata: { kind },
      // `before` is null throughout: this option did not exist a moment ago.
      changes: [
        { field: 'Name', before: null, after: row.name },
        { field: 'Arabic name', before: null, after: row.nameAr },
        { field: 'Display order', before: null, after: row.displayOrder },
      ],
    });
    return row;
  }

  private async updateOption(
    delegate: {
      findUnique: (args: { where: { id: string } }) => Promise<StudyConfigOptionRow | null>;
      update: (args: {
        where: { id: string };
        data: { name?: string; nameAr?: string; displayOrder?: number };
      }) => Promise<StudyConfigOptionRow>;
    },
    id: string,
    payload: UpdateStudyConfigOptionPayload,
    kind: string,
  ): Promise<StudyConfigOptionRow> {
    const existing = await delegate.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({ error: { code: 'OPTION_NOT_FOUND', message: 'Option not found.' } });
    }
    let row: StudyConfigOptionRow;
    try {
      row = await delegate.update({
        where: { id },
        data: { name: payload.name, nameAr: payload.nameAr, displayOrder: payload.displayOrder },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        if (err.code === 'P2002') {
          throw new ConflictException({
            error: { code: 'OPTION_NAME_TAKEN', message: `"${payload.name}" already exists.` },
          });
        }
        if (err.code === 'P2025') {
          throw new NotFoundException({ error: { code: 'OPTION_NOT_FOUND', message: 'Option not found.' } });
        }
      }
      throw err;
    }
    const changes: AuditChange[] = [];
    if (payload.name !== undefined && payload.name !== existing.name) {
      changes.push({ field: 'Name', before: existing.name, after: payload.name });
    }
    if (payload.nameAr !== undefined && payload.nameAr !== existing.nameAr) {
      changes.push({ field: 'Arabic name', before: existing.nameAr, after: payload.nameAr });
    }
    if (payload.displayOrder !== undefined && payload.displayOrder !== existing.displayOrder) {
      changes.push({ field: 'Display order', before: existing.displayOrder, after: payload.displayOrder });
    }
    await this.audit.record({
      action: 'edit',
      entityType: 'study_config_option',
      entityId: row.id,
      entityLabel: `${kind}: ${row.name}`,
      metadata: { kind },
      changes,
    });
    return row;
  }

  private async setActive(
    delegate: {
      findUnique: (args: { where: { id: string } }) => Promise<StudyConfigOptionRow | null>;
      update: (args: { where: { id: string }; data: { isActive: boolean } }) => Promise<StudyConfigOptionRow>;
    },
    id: string,
    isActive: boolean,
    kind: string,
  ): Promise<StudyConfigOptionRow> {
    const existing = await delegate.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({ error: { code: 'OPTION_NOT_FOUND', message: 'Option not found.' } });
    }
    let row: StudyConfigOptionRow;
    try {
      row = await delegate.update({ where: { id }, data: { isActive } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException({ error: { code: 'OPTION_NOT_FOUND', message: 'Option not found.' } });
      }
      throw err;
    }
    await this.audit.record({
      action: 'edit',
      entityType: 'study_config_option',
      entityId: row.id,
      entityLabel: `${kind}: ${row.name}`,
      metadata: { kind },
      changes: [{ field: 'Active', before: existing.isActive, after: isActive }],
    });
    return row;
  }

  private toOption(row: StudyConfigOptionRow): StudyConfigOption {
    return {
      id: row.id,
      name: row.name,
      nameAr: row.nameAr,
      displayOrder: row.displayOrder,
      isActive: row.isActive,
    };
  }
}

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma';
import { PrismaService } from '../../prisma/prisma.service';
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
  constructor(private readonly prisma: PrismaService) {}

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
    return this.toOption(await this.createOption(this.prisma.needThemeOption, payload));
  }

  async updateNeedTheme(id: string, payload: UpdateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    return this.toOption(await this.updateOption(this.prisma.needThemeOption, id, payload));
  }

  async setNeedThemeActive(id: string, isActive: boolean): Promise<StudyConfigOption> {
    return this.toOption(await this.setActive(this.prisma.needThemeOption, id, isActive));
  }

  async createStudyType(payload: CreateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    const row = await this.createOption(this.prisma.studyTypeOption, payload);
    return this.toOption(row);
  }

  async updateStudyType(id: string, payload: UpdateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    const row = await this.updateOption(this.prisma.studyTypeOption, id, payload);
    return this.toOption(row);
  }

  async setStudyTypeActive(id: string, isActive: boolean): Promise<StudyConfigOption> {
    const row = await this.setActive(this.prisma.studyTypeOption, id, isActive);
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
    const row = await this.createOption(this.prisma.targetSectorOption, payload);
    return this.toOption(row);
  }

  async updateTargetSector(id: string, payload: UpdateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    const row = await this.updateOption(this.prisma.targetSectorOption, id, payload);
    return this.toOption(row);
  }

  async setTargetSectorActive(id: string, isActive: boolean): Promise<StudyConfigOption> {
    const row = await this.setActive(this.prisma.targetSectorOption, id, isActive);
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
    const row = await this.createOption(this.prisma.decisionTypeOption, payload);
    return this.toOption(row);
  }

  async updateDecisionType(id: string, payload: UpdateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    const row = await this.updateOption(this.prisma.decisionTypeOption, id, payload);
    return this.toOption(row);
  }

  async setDecisionTypeActive(id: string, isActive: boolean): Promise<StudyConfigOption> {
    const row = await this.setActive(this.prisma.decisionTypeOption, id, isActive);
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
    const row = await this.createOption(this.prisma.gapTypeOption, payload);
    return this.toOption(row);
  }

  async updateGapType(id: string, payload: UpdateStudyConfigOptionPayload): Promise<StudyConfigOption> {
    const row = await this.updateOption(this.prisma.gapTypeOption, id, payload);
    return this.toOption(row);
  }

  async setGapTypeActive(id: string, isActive: boolean): Promise<StudyConfigOption> {
    const row = await this.setActive(this.prisma.gapTypeOption, id, isActive);
    return this.toOption(row);
  }

  // Shared CRUD body for both option tables — identical shape (id, name,
  // displayOrder, isActive), so one implementation parametrized on the
  // Prisma delegate avoids maintaining two copies of the same try/catch and
  // not-found handling.
  private async createOption(
    delegate: { create: (args: { data: { name: string; displayOrder?: number } }) => Promise<StudyConfigOptionRow> },
    payload: CreateStudyConfigOptionPayload,
  ): Promise<StudyConfigOptionRow> {
    try {
      return await delegate.create({
        data: { name: payload.name, displayOrder: payload.displayOrder },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          error: { code: 'OPTION_NAME_TAKEN', message: `"${payload.name}" already exists.` },
        });
      }
      throw err;
    }
  }

  private async updateOption(
    delegate: {
      update: (args: { where: { id: string }; data: { name?: string; displayOrder?: number } }) => Promise<StudyConfigOptionRow>;
    },
    id: string,
    payload: UpdateStudyConfigOptionPayload,
  ): Promise<StudyConfigOptionRow> {
    try {
      return await delegate.update({
        where: { id },
        data: { name: payload.name, displayOrder: payload.displayOrder },
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
  }

  private async setActive(
    delegate: { update: (args: { where: { id: string }; data: { isActive: boolean } }) => Promise<StudyConfigOptionRow> },
    id: string,
    isActive: boolean,
  ): Promise<StudyConfigOptionRow> {
    try {
      return await delegate.update({ where: { id }, data: { isActive } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        throw new NotFoundException({ error: { code: 'OPTION_NOT_FOUND', message: 'Option not found.' } });
      }
      throw err;
    }
  }

  private toOption(row: StudyConfigOptionRow): StudyConfigOption {
    return { id: row.id, name: row.name, displayOrder: row.displayOrder, isActive: row.isActive };
  }
}

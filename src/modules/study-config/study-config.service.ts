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

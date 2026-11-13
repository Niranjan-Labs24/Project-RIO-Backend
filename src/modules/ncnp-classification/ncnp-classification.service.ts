import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuditChange } from '../audit/audit.types';
import type { CreateNcnpClassificationDto, UpdateNcnpClassificationDto } from './ncnp-classification.contract';
import type {
  NcnpClassificationItem,
  NcnpClassificationLevel,
  OrganisationClassification,
} from './ncnp-classification.types';

type Row = {
  id: string; code: string; level: number; parentId: string | null; name: string;
  definition: string | null; supervisingEntity: string | null; displayOrder: number; isActive: boolean;
};

const LEVEL_LABEL: Record<NcnpClassificationLevel, string> = { 1: 'Group', 2: 'Level A', 3: 'Level B' };
const ORDER = [{ level: 'asc' as const }, { displayOrder: 'asc' as const }, { code: 'asc' as const }];

// GEN-07 (UAT v1.4) — NCNP's official classification list, platform-wide
// reference data maintained by the System Admin. Items are deactivated, never
// deleted, so every organisation's stored classification keeps resolving.
@Injectable()
export class NcnpClassificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Active items only — the picklist for registration and entity screens. */
  async listActive(): Promise<NcnpClassificationItem[]> {
    const rows = await this.prisma.ncnpClassification.findMany({ where: { isActive: true }, orderBy: ORDER });
    return rows.map(toItem);
  }

  /** Every item, active or not — the System Admin maintenance screen. */
  async listAll(): Promise<NcnpClassificationItem[]> {
    const rows = await this.prisma.ncnpClassification.findMany({ orderBy: ORDER });
    return rows.map(toItem);
  }

  async create(dto: CreateNcnpClassificationDto): Promise<NcnpClassificationItem> {
    const level = dto.level as NcnpClassificationLevel;
    let parent: Row | null = null;
    if (level === 1) {
      if (dto.parentId) throw badRequest('NCNP_CLASSIFICATION_PARENT_INVALID', 'A group has no parent.');
    } else {
      if (!dto.parentId) throw badRequest('NCNP_CLASSIFICATION_PARENT_REQUIRED', 'Choose the parent item.');
      parent = await this.prisma.ncnpClassification.findUnique({ where: { id: dto.parentId } });
      if (!parent || parent.level !== level - 1) {
        throw badRequest('NCNP_CLASSIFICATION_PARENT_INVALID', 'The parent must be one level above.');
      }
    }
    const siblings = await this.prisma.ncnpClassification.findMany({
      where: { level, parentId: parent?.id ?? null },
      select: { code: true, displayOrder: true },
    });
    const next = siblings.reduce((max, s) => Math.max(max, Number(/(\d+)$/.exec(s.code)?.[1] ?? 0)), 0) + 1;
    const prefix = level === 1 ? 'G' : level === 2 ? 'A' : 'B';
    const code = `${parent ? `${parent.code}-` : ''}${prefix}${String(next).padStart(2, '0')}`;
    const displayOrder = siblings.reduce((max, s) => Math.max(max, s.displayOrder), 0) + 1;
    const row = await this.prisma.ncnpClassification.create({
      data: {
        code, level, parentId: parent?.id ?? null, name: dto.name.trim(),
        definition: level === 3 ? clean(dto.definition) : null,
        supervisingEntity: level === 3 ? clean(dto.supervisingEntity) : null,
        displayOrder,
      },
    });
    await this.audit.record({
      action: 'create',
      entityType: 'ncnp_classification',
      entityId: row.id,
      entityLabel: `${LEVEL_LABEL[level]}: ${row.name}`,
      metadata: { code: row.code, level },
      changes: [
        { field: 'Name', before: null, after: row.name },
        ...(level === 3
          ? [
              { field: 'Definition', before: null, after: row.definition },
              { field: 'Supervising entity', before: null, after: row.supervisingEntity },
            ]
          : []),
      ],
    });
    return toItem(row);
  }

  async update(id: string, dto: UpdateNcnpClassificationDto): Promise<NcnpClassificationItem> {
    const existing = await this.prisma.ncnpClassification.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException({ error: { code: 'NCNP_CLASSIFICATION_NOT_FOUND', message: 'Classification not found.' } });
    }
    const isLevelB = existing.level === 3;
    const data = {
      ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
      ...(dto.definition !== undefined && isLevelB ? { definition: clean(dto.definition) } : {}),
      ...(dto.supervisingEntity !== undefined && isLevelB ? { supervisingEntity: clean(dto.supervisingEntity) } : {}),
      ...(dto.displayOrder !== undefined ? { displayOrder: dto.displayOrder } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
    };
    const row = await this.prisma.ncnpClassification.update({ where: { id }, data });
    const changes: AuditChange[] = [];
    const diff = (field: string, before: unknown, after: unknown) => {
      if (before !== after) changes.push({ field, before: before as never, after: after as never });
    };
    diff('Name', existing.name, row.name);
    diff('Definition', existing.definition, row.definition);
    diff('Supervising entity', existing.supervisingEntity, row.supervisingEntity);
    diff('Display order', existing.displayOrder, row.displayOrder);
    diff('Active', existing.isActive, row.isActive);
    await this.audit.record({
      action: 'edit',
      entityType: 'ncnp_classification',
      entityId: row.id,
      entityLabel: `${LEVEL_LABEL[row.level as NcnpClassificationLevel]}: ${row.name}`,
      metadata: { code: row.code, level: row.level },
      changes,
    });
    return toItem(row);
  }

  /**
   * Validates a Level B id chosen on registration or an entity screen.
   * Throws a 400 the forms show next to the field.
   */
  async assertSelectableLevelB(id: string | null | undefined): Promise<void> {
    if (!id) {
      throw badRequest('NCNP_CLASSIFICATION_REQUIRED', 'Choose the entity classification down to Level B.');
    }
    const row = await this.prisma.ncnpClassification.findUnique({ where: { id }, select: { level: true, isActive: true } });
    if (!row || row.level !== 3 || !row.isActive) {
      throw badRequest('NCNP_CLASSIFICATION_INVALID', 'Choose an active Level B classification.');
    }
  }

  /** Group / Level A / Level B for each given Level B id. */
  async resolve(ids: Array<string | null | undefined>): Promise<Map<string, OrganisationClassification>> {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    const out = new Map<string, OrganisationClassification>();
    if (wanted.length === 0) return out;
    const leaves = await this.prisma.ncnpClassification.findMany({
      where: { id: { in: wanted } },
      include: { parent: { include: { parent: true } } },
    });
    for (const b of leaves) {
      const a = b.parent;
      const g = a?.parent;
      if (!a || !g) continue;
      out.set(b.id, {
        groupId: g.id, groupName: g.name,
        levelAId: a.id, levelAName: a.name,
        levelBId: b.id, levelBName: b.name,
        definition: b.definition,
      });
    }
    return out;
  }
}

function toItem(r: Row): NcnpClassificationItem {
  return {
    id: r.id, code: r.code, level: r.level as NcnpClassificationLevel, parentId: r.parentId, name: r.name,
    definition: r.definition, supervisingEntity: r.supervisingEntity, displayOrder: r.displayOrder, isActive: r.isActive,
  };
}

function clean(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

function badRequest(code: string, message: string): BadRequestException {
  return new BadRequestException({ error: { code, message } });
}

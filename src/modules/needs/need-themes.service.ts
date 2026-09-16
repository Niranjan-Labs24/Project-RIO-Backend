import { EXCLUDE_MERGED } from './need-visibility';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireOrgId } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import { AiService } from '../ai/ai.service';
import { NEED_THEME_EXTRACTION_TASK } from '../ai/prompts/need-theme-extraction.task';
import { StudyConfigService } from '../study-config/study-config.service';
import { redactPii } from '../ai-decisions/classification.placeholder';

/**
 * RIO-FR-003 AC 6 — extracts the recurring themes a need is about, and counts
 * how many other needs share them.
 *
 * That count is the methodology's "recurrence of similar needs" factor. It is
 * deliberately built on shared themes rather than on RIO-AI-004's semantic
 * duplicate detection: two needs sharing "distance to facility" are the same
 * underlying problem for counting purposes, which is a far weaker claim than
 * "these two records are duplicates and one should be merged into the other".
 * The weaker claim is the one this factor actually needs, and it does not
 * block on a Sprint 3 ticket.
 *
 * Extraction never fails the caller, for the same reason as the summary and
 * classification paths: the need is already saved, and themes are assistive.
 */
@Injectable()
export class NeedThemesService {
  private readonly logger = new Logger(NeedThemesService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly ai: AiService,
    private readonly audit: AuditService,
    private readonly studyConfig: StudyConfigService,
  ) {}

  /** Auto-trigger, called after a need is created or its statement edited.
   *  Swallows and logs — see the class comment. */
  async maybeExtractForNeed(needId: string): Promise<string[] | null> {
    try {
      return await this.extract(needId);
    } catch (err) {
      this.logger.warn(
        `Theme extraction skipped for need ${needId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** The explicit re-extract action. Throws so the button can report why. */
  async extract(needId: string): Promise<string[]> {
    const orgId = requireOrgId();

    const need = await this.tenant.runInOrgContext((tx) =>
      tx.need.findFirst({ where: { id: needId, orgId } }),
    );
    if (!need) {
      throw new NotFoundException({
        error: { code: 'NEED_NOT_FOUND', message: `Need ${needId} not found.` },
      });
    }

    const vocabulary = await this.studyConfig.listActiveNeedThemeNames();
    // No vocabulary means nothing legitimate can be returned. Extracting
    // against an empty list would invite the model to invent themes, which is
    // precisely what AC 6's filter cannot survive.
    if (vocabulary.length === 0) return [];

    const statement = (need.statement ?? '').trim();
    if (statement.length === 0) return [];

    const prompt = `ALLOWED THEMES (choose only from this list, verbatim):
${vocabulary.map((t) => `- ${t}`).join('\n')}

NEED STATEMENT:
${redactPii(statement)}`;

    const { response } = await this.ai.run(NEED_THEME_EXTRACTION_TASK, prompt);

    // Belt and braces over the prompt's own rule: drop anything not in the
    // vocabulary, and de-duplicate. A hallucinated theme would create a filter
    // group of one and inflate nothing, but it would still be a lie on screen.
    const allowed = new Set(vocabulary);
    const themes = [...new Set((response.themes ?? []).filter((t) => allowed.has(t)))].slice(0, 3);

    const before = need.themes ?? [];
    await this.tenant.runInOrgContext((tx) =>
      tx.need.update({ where: { id: needId }, data: { themes } }),
    );

    if (JSON.stringify(before) !== JSON.stringify(themes)) {
      await this.audit.record({
        action: 'extract_need_themes',
        entityType: 'need',
        entityId: needId,
        entityLabel: need.title ?? needId,
        changes: [{ field: 'themes', before, after: themes }],
      });
    }

    return themes;
  }

  /**
   * How many OTHER needs in this org share at least one theme with this one —
   * the raw value behind the recurrence factor.
   *
   * Counts needs, not theme hits: a need sharing two themes is still one other
   * need, and counting hits would let a single richly-tagged need look like a
   * region-wide pattern.
   */
  async countSharingThemes(needId: string, themes: string[]): Promise<number> {
    if (themes.length === 0) return 0;
    const orgId = requireOrgId();
    return this.tenant.runInOrgContext((tx) =>
      tx.need.count({
        where: { orgId, id: { not: needId }, themes: { hasSome: themes } },
      }),
    );
  }

  /** AC 6's grouping — every theme in use, with how many needs carry it. */
  async listThemeCounts(): Promise<Array<{ theme: string; needCount: number }>> {
    const orgId = requireOrgId();
    const rows = await this.tenant.runInOrgContext((tx) =>
      tx.need.findMany({ where: { orgId, ...EXCLUDE_MERGED }, select: { themes: true } }),
    );
    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const theme of row.themes ?? []) {
        counts.set(theme, (counts.get(theme) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([theme, needCount]) => ({ theme, needCount }))
      .sort((a, b) => b.needCount - a.needCount || a.theme.localeCompare(b.theme));
  }
}

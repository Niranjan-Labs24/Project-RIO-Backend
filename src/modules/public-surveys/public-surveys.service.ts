import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Prisma } from '../../generated/prisma';
import { ConfigService } from '../../config/config.service';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireOrgId, requireActor } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import type {
  CreateSurveyLinkPayload,
  PublicSurveyLink,
  PublicSurveyLinkRow,
  SurveyResponseAnswer,
  SurveyResponseDetail,
  SurveyResponseSummary,
} from './public-surveys.types';

type LinkWithResponseCount = Omit<PublicSurveyLinkRow, 'responseCount'> & { _count: { responses: number } };

@Injectable()
export class PublicSurveysService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async listLinks(needId: string): Promise<PublicSurveyLink[]> {
    await this.findNeedOrThrow(needId);
    const rows = await this.tenant.runInOrgContext((tx) =>
      tx.publicSurveyLink.findMany({
        where: { needId },
        orderBy: { createdAt: 'desc' },
        include: { _count: { select: { responses: true } } },
      }),
    );
    return rows.map((r) => this.toPublicLink(r as unknown as LinkWithResponseCount));
  }

  async createLink(needId: string, payload: CreateSurveyLinkPayload): Promise<PublicSurveyLink> {
    const need = await this.findNeedOrThrow(needId);
    const orgId = requireOrgId();
    const actorId = requireActor();
    const token = randomBytes(24).toString('base64url');
    const expiresAt = payload.expiresInDays
      ? new Date(Date.now() + payload.expiresInDays * 24 * 60 * 60 * 1000)
      : null;
    // Contract-level `pattern: '\S'` already rejects an all-whitespace body,
    // so trimming here can only shrink a valid label, never produce a blank
    // one — no need to re-check blankness after trim.
    const label = payload.label.trim();

    let row: LinkWithResponseCount;
    try {
      row = (await this.tenant.runInOrgContext((tx) =>
        tx.publicSurveyLink.create({
          data: { orgId, needId, studyId: need.studyId, label, token, createdBy: actorId, expiresAt },
          include: { _count: { select: { responses: true } } },
        }),
      )) as unknown as LinkWithResponseCount;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException({
          error: { code: 'SURVEY_LINK_LABEL_ALREADY_EXISTS', message: 'A survey link with this label already exists for this need.' },
        });
      }
      throw err;
    }
    await this.audit.record({ action: 'create', entityType: 'survey', entityId: row.id, entityLabel: label });
    return this.toPublicLink(row);
  }

  async deactivateLink(needId: string, linkId: string): Promise<PublicSurveyLink> {
    await this.findNeedOrThrow(needId);
    const row = await this.tenant.runInOrgContext(async (tx) => {
      const existing = await tx.publicSurveyLink.findUnique({ where: { id: linkId } });
      if (!existing || existing.needId !== needId) {
        throw new NotFoundException({ error: { code: 'SURVEY_LINK_NOT_FOUND', message: 'Survey link not found' } });
      }
      return tx.publicSurveyLink.update({
        where: { id: linkId },
        data: { isActive: false },
        include: { _count: { select: { responses: true } } },
      });
    });
    await this.audit.record({ action: 'edit', entityType: 'survey', entityId: row.id, entityLabel: row.label, changes: [{ field: 'isActive', before: true, after: false }] });
    return this.toPublicLink(row as unknown as LinkWithResponseCount);
  }

  // Survey Responses — Name/Email/Submitted Date list, single-response
  // detail, and CSV/Excel export. Reads the citizen flow's own
  // SurveyResponse rows (see CitizenService.submitResponse) — never the
  // separate Survey Builder preview response table (SurveyBuilderResponse).
  // `surveyLinkId` narrows to one link; omitted = every link for this Need.
  async listResponses(needId: string, surveyLinkId?: string): Promise<SurveyResponseSummary[]> {
    await this.findNeedOrThrow(needId);
    const rows = await this.tenant.runInOrgContext((tx) =>
      tx.surveyResponse.findMany({
        where: { needId, ...(surveyLinkId ? { surveyLinkId } : {}) },
        orderBy: { submittedAt: 'desc' },
      }),
    );
    return rows.map((r) => this.toResponseSummary(r));
  }

  async getResponse(needId: string, responseId: string): Promise<SurveyResponseDetail> {
    await this.findNeedOrThrow(needId);
    const { row, questionMap } = await this.tenant.runInOrgContext(async (tx) => {
      const row = await tx.surveyResponse.findUnique({ where: { id: responseId } });
      if (!row || row.needId !== needId) {
        throw new NotFoundException({ error: { code: 'SURVEY_RESPONSE_NOT_FOUND', message: 'Survey response not found' } });
      }
      const questionMap = await this.buildQuestionMap(tx, needId);
      return { row, questionMap };
    });
    return this.toResponseDetail(row, questionMap);
  }

  async exportResponsesCsv(needId: string, surveyLinkId?: string): Promise<string> {
    const { rows, questionMap } = await this.loadResponsesForExport(needId, surveyLinkId);
    const questions = Array.from(questionMap.values());
    const header = ['Name', 'Email', 'Submitted Date', ...questions.map((q) => q.questionText)];
    const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
    const csvRows = rows.map((row) => {
      const answers = (row.answers ?? {}) as Record<string, string>;
      return [
        row.contactName ?? '',
        row.contact,
        row.submittedAt.toISOString(),
        ...questions.map((q) => answers[q.questionId] ?? ''),
      ]
        .map((v) => escape(String(v)))
        .join(',');
    });
    return [header.map(escape).join(','), ...csvRows].join('\n');
  }

  async exportResponsesExcel(needId: string, surveyLinkId?: string): Promise<Buffer> {
    const { rows, questionMap } = await this.loadResponsesForExport(needId, surveyLinkId);
    const questions = Array.from(questionMap.values());

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'RIO';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Survey Responses');
    sheet.columns = [
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Email', key: 'email', width: 28 },
      { header: 'Submitted Date', key: 'submittedAt', width: 22 },
      ...questions.map((q) => ({ header: q.questionText, key: q.questionId, width: 32 })),
    ];
    sheet.getRow(1).font = { bold: true };
    for (const row of rows) {
      const answers = (row.answers ?? {}) as Record<string, string>;
      sheet.addRow({
        name: row.contactName ?? '',
        email: row.contact,
        submittedAt: row.submittedAt.toISOString(),
        ...Object.fromEntries(questions.map((q) => [q.questionId, answers[q.questionId] ?? ''])),
      });
    }

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(arrayBuffer);
  }

  private async loadResponsesForExport(needId: string, surveyLinkId?: string) {
    await this.findNeedOrThrow(needId);
    return this.tenant.runInOrgContext(async (tx) => {
      const rows = await tx.surveyResponse.findMany({
        where: { needId, ...(surveyLinkId ? { surveyLinkId } : {}) },
        orderBy: { submittedAt: 'desc' },
      });
      const questionMap = await this.buildQuestionMap(tx, needId);
      return { rows, questionMap };
    });
  }

  // Maps SurveyQuestion.id -> {questionText, answerType} for the Need's
  // survey — the same key `answers` on a SurveyResponse row is keyed by
  // (see CitizenService.submitResponse / SurveysService.toQuestionDto).
  // Bank questions read text/type from the Question row; additional
  // (open-ended) questions read their own customText/customAnswerType.
  private async buildQuestionMap(
    tx: Prisma.TransactionClient,
    needId: string,
  ): Promise<Map<string, { questionId: string; questionText: string; answerType: string }>> {
    const survey = await tx.survey.findFirst({
      where: { needId },
      include: { surveyQuestions: { include: { question: true }, orderBy: { order: 'asc' } } },
    });
    const map = new Map<string, { questionId: string; questionText: string; answerType: string }>();
    for (const sq of survey?.surveyQuestions ?? []) {
      map.set(sq.id, {
        questionId: sq.id,
        questionText: sq.question?.questionText ?? sq.customText ?? '',
        answerType: sq.question?.answerType ?? sq.customAnswerType ?? 'long_text',
      });
    }
    return map;
  }

  private toResponseSummary(row: {
    id: string;
    needId: string;
    surveyLinkId: string;
    contactName: string | null;
    contact: string;
    submittedAt: Date;
  }): SurveyResponseSummary {
    return {
      id: row.id,
      needId: row.needId,
      surveyLinkId: row.surveyLinkId,
      contactName: row.contactName,
      contact: row.contact,
      submittedAt: row.submittedAt.toISOString(),
    };
  }

  private toResponseDetail(
    row: {
      id: string;
      needId: string;
      surveyLinkId: string;
      contactName: string | null;
      contact: string;
      submittedAt: Date;
      answers: unknown;
    },
    questionMap: Map<string, { questionId: string; questionText: string; answerType: string }>,
  ): SurveyResponseDetail {
    const rawAnswers = (row.answers ?? {}) as Record<string, string>;
    const answers: SurveyResponseAnswer[] = Array.from(questionMap.values()).map((q) => ({
      questionId: q.questionId,
      questionText: q.questionText,
      answerType: q.answerType,
      answer: rawAnswers[q.questionId] ?? null,
    }));
    return { ...this.toResponseSummary(row), answers };
  }

  private async findNeedOrThrow(needId: string) {
    const need = await this.tenant.runInOrgContext((tx) => tx.need.findUnique({ where: { id: needId } }));
    if (!need) throw new NotFoundException({ error: { code: 'NEED_NOT_FOUND', message: 'Need not found' } });
    return need;
  }

  private toPublicLink(row: LinkWithResponseCount): PublicSurveyLink {
    return {
      id: row.id,
      needId: row.needId,
      studyId: row.studyId,
      label: row.label,
      token: row.token,
      publicUrl: `${this.config.publicAppUrl}/public/survey/${row.token}`,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      isActive: row.isActive,
      createdAt: row.createdAt.toISOString(),
      responseCount: row._count.responses,
    };
  }
}

import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import QRCode from 'qrcode';
import { Prisma, type SurveyResponse } from '../../generated/prisma';
import { ConfigService } from '../../config/config.service';
import { TenantPrismaService } from '../../tenancy/tenant-prisma.service';
import { requireOrgId, requireActor } from '../../tenancy/org-context';
import { AuditService } from '../audit/audit.service';
import { MailerService } from '../../mailer/mailer.service';
import { sanitizeForSpreadsheet } from '../../common/security/spreadsheet-sanitize';
import type {
  CreateSurveyLinkPayload,
  PublicSurveyLink,
  PublicSurveyLinkRow,
  QuestionResponseListResult,
  SurveyResponseAnswer,
  SurveyResponseDetail,
  SurveyResponseListResult,
  SurveyResponseSummary,
} from './public-surveys.types';

type LinkWithResponseCount = Omit<PublicSurveyLinkRow, 'responseCount'> & { _count: { responses: number } };

// Hard ceiling for the two unbounded-by-design reads below
// (listResponsesWithAnswers, the CSV/XLSX export loader) — neither paginates
// today (the summary screen and export both need every matching row, not a
// page of them), so without some bound a single Need with a pathologically
// large response count (abuse, or a bulk-import mistake) can pull unbounded
// rows into process memory in one query. 50,000 is far beyond any real
// community-assessment survey's realistic respondent count for one Need,
// so this changes no real-world behavior — it only stops the unbounded case.
const MAX_EXPORTABLE_RESPONSES = 50_000;

// Cursor-batch size for the export readers below — bounds how many
// SurveyResponse rows are ever in memory at once (as opposed to one
// `take: MAX_EXPORTABLE_RESPONSES` findMany pulling up to 50,000 full rows,
// each carrying a `Json` answers blob, into memory simultaneously). `id` is
// a uuidv7 (time-ordered) so `orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }]`
// with an `id` cursor gives a stable, gapless total order across batches even
// when multiple responses share the same `submittedAt` millisecond.
const EXPORT_BATCH_SIZE = 1_000;

@Injectable()
export class PublicSurveysService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly mailer: MailerService,
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
    await this.audit.record({
      action: 'create', entityType: 'survey', entityId: row.id, entityLabel: label,
      changes: [
        { field: 'Link label', before: null, after: label },
        { field: 'Linked need', before: null, after: need.title },
        { field: 'Active', before: null, after: row.isActive },
      ],
    });
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

  // Sends the link (plus the same QR code shown in-app, generated fresh
  // server-side rather than trusting a client-supplied image) as a real,
  // formatted email — a mailto: link can't carry an attached image at all,
  // so this is the only way to actually deliver "link + QR code" together.
  async shareLinkByEmail(needId: string, linkId: string, email: string): Promise<void> {
    const need = await this.findNeedOrThrow(needId);
    const link = await this.tenant.runInOrgContext(async (tx) => {
      const existing = await tx.publicSurveyLink.findUnique({ where: { id: linkId } });
      if (!existing || existing.needId !== needId) {
        throw new NotFoundException({ error: { code: 'SURVEY_LINK_NOT_FOUND', message: 'Survey link not found' } });
      }
      return existing;
    });
    const publicUrl = `${this.config.publicAppUrl}/public/survey/${link.token}`;
    const qrCodePng = await QRCode.toBuffer(publicUrl, { type: 'png', width: 300, margin: 1 });

    const sent = await this.mailer.sendSurveyLink(email, {
      needTitle: need.title,
      linkLabel: link.label,
      publicUrl,
      qrCodePng,
    });
    if (!sent) {
      throw new ServiceUnavailableException({
        error: { code: 'SURVEY_LINK_EMAIL_FAILED', message: 'Could not send the survey link by email. Please try again.' },
      });
    }
    await this.audit.record({
      action: 'share',
      entityType: 'survey',
      entityId: link.id,
      entityLabel: link.label,
      metadata: { channel: 'email' },
      // A share mutates nothing on the link, so the pair records what was
      // sent and to whom rather than a field transition.
      changes: [
        { field: 'Shared via', before: null, after: 'email' },
        { field: 'Recipient', before: null, after: email },
        { field: 'Survey link', before: null, after: link.label },
      ],
    });
  }

  // Survey Responses — Name/Email/Submitted Date list, single-response
  // detail, and CSV/Excel export. Reads the citizen flow's own
  // SurveyResponse rows (see CitizenService.submitResponse) — never the
  // separate Survey Builder preview response table (SurveyBuilderResponse).
  // `surveyLinkId` narrows to one link; omitted = every link for this Need.
  // Server-paginated (same take/skip clamp as StudiesService#list) — a
  // popular public link can collect thousands of responses, so the list
  // page never loads more than one page's worth at a time.
  async listResponses(
    needId: string,
    opts: { surveyLinkId?: string; limit?: number; offset?: number; search?: string } = {},
  ): Promise<SurveyResponseListResult> {
    await this.findNeedOrThrow(needId);
    const take = Math.min(Math.max(opts.limit ?? 10, 1), 200);
    const skip = Math.max(opts.offset ?? 0, 0);
    const search = opts.search?.trim();
    const where = {
      needId,
      ...(opts.surveyLinkId ? { surveyLinkId: opts.surveyLinkId } : {}),
      ...(search
        ? {
            OR: [
              { contactName: { contains: search, mode: 'insensitive' as const } },
              { contact: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.tenant.runInOrgContext((tx) =>
      Promise.all([
        tx.surveyResponse.findMany({ where, orderBy: { submittedAt: 'desc' }, take, skip }),
        tx.surveyResponse.count({ where }),
      ]),
    );
    return {
      items: rows.map((r) => this.toResponseSummary(r)),
      total,
      limit: take,
      offset: skip,
    };
  }

  // Same rows as listResponses, but with each one's full answers already
  // joined in — one round trip for a Survey Responses summary screen to
  // build its own question-wise tallies/min-max-average from, instead of
  // fetching every response's detail one at a time.
  async listResponsesWithAnswers(needId: string, surveyLinkId?: string): Promise<SurveyResponseDetail[]> {
    await this.findNeedOrThrow(needId);
    const { rows, questionMap } = await this.tenant.runInOrgContext(async (tx) => {
      const rows = await tx.surveyResponse.findMany({
        where: { needId, ...(surveyLinkId ? { surveyLinkId } : {}) },
        orderBy: { submittedAt: 'desc' },
        take: MAX_EXPORTABLE_RESPONSES,
      });
      const questionMap = await this.buildQuestionMap(tx, needId);
      return { rows, questionMap };
    });
    return rows.map((r) => this.toResponseDetail(r, questionMap));
  }

  // Backs the dedicated per-question responses page — never load every
  // response's full answer set client-side just to filter down to one
  // question (that's what the old dialog did); paginate and search at the
  // DB level exactly like listResponses above.
  async listQuestionResponses(
    needId: string,
    questionId: string,
    opts: { limit?: number; offset?: number; search?: string } = {},
  ): Promise<QuestionResponseListResult> {
    await this.findNeedOrThrow(needId);
    const take = Math.min(Math.max(opts.limit ?? 10, 1), 200);
    const skip = Math.max(opts.offset ?? 0, 0);
    const search = opts.search?.trim();
    const where = {
      needId,
      ...(search
        ? {
            OR: [
              { contactName: { contains: search, mode: 'insensitive' as const } },
              { contact: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const { rows, total, questionMap } = await this.tenant.runInOrgContext(async (tx) => {
      const [rows, total, questionMap] = await Promise.all([
        tx.surveyResponse.findMany({ where, orderBy: { submittedAt: 'desc' }, take, skip }),
        tx.surveyResponse.count({ where }),
        this.buildQuestionMap(tx, needId),
      ]);
      return { rows, total, questionMap };
    });

    const question = questionMap.get(questionId);
    return {
      questionId,
      questionText: question?.questionText ?? '',
      answerType: question?.answerType ?? 'long_text',
      total,
      limit: take,
      offset: skip,
      items: rows.map((r) => ({
        responseId: r.id,
        respondentName: r.contactName,
        contact: r.contact,
        answer: ((r.answers ?? {}) as Record<string, string>)[questionId] ?? null,
        submittedAt: r.submittedAt.toISOString(),
      })),
    };
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
    await this.findNeedOrThrow(needId);
    const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
    return this.tenant.runInOrgContext(async (tx) => {
      const questionMap = await this.buildQuestionMap(tx, needId);
      const questions = Array.from(questionMap.values());
      const lines = [
        ['Name', 'Email', 'Submitted Date', ...questions.map((q) => q.questionText)].map(escape).join(','),
      ];
      for await (const batch of this.iterateResponsesForExport(tx, needId, surveyLinkId)) {
        for (const row of batch) {
          const answers = (row.answers ?? {}) as Record<string, string>;
          lines.push(
            [
              sanitizeForSpreadsheet(row.contactName ?? ''),
              sanitizeForSpreadsheet(row.contact),
              row.submittedAt.toISOString(),
              ...questions.map((q) => sanitizeForSpreadsheet(answers[q.questionId] ?? '')),
            ]
              .map((v) => escape(String(v)))
              .join(','),
          );
        }
      }
      return lines.join('\n');
    });
  }

  async exportResponsesExcel(needId: string, surveyLinkId?: string): Promise<Buffer> {
    await this.findNeedOrThrow(needId);
    return this.tenant.runInOrgContext(async (tx) => {
      const questionMap = await this.buildQuestionMap(tx, needId);
      const questions = Array.from(questionMap.values());

      // Streaming writer, not the in-memory Workbook/Worksheet API: rows are
      // committed (and released from ExcelJS's own memory) one batch at a
      // time as they're written, rather than the whole sheet accumulating in
      // memory before a single writeBuffer() call — bounds ExcelJS's own
      // memory usage to ~EXPORT_BATCH_SIZE rows at a time regardless of how
      // many total rows the export contains (up to the MAX_EXPORTABLE_
      // RESPONSES cap).
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk: Buffer, _enc, callback) {
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useStyles: true });
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
      sheet.getRow(1).commit();

      for await (const batch of this.iterateResponsesForExport(tx, needId, surveyLinkId)) {
        for (const row of batch) {
          const answers = (row.answers ?? {}) as Record<string, string>;
          const excelRow = sheet.addRow({
            name: sanitizeForSpreadsheet(row.contactName ?? ''),
            email: sanitizeForSpreadsheet(row.contact),
            submittedAt: row.submittedAt.toISOString(),
            ...Object.fromEntries(
              questions.map((q) => [q.questionId, sanitizeForSpreadsheet(answers[q.questionId] ?? '')]),
            ),
          });
          excelRow.commit();
        }
      }
      sheet.commit();
      await workbook.commit();
      return Buffer.concat(chunks);
    });
  }

  // Cursor-paginated in batches of EXPORT_BATCH_SIZE, capped in total at
  // MAX_EXPORTABLE_RESPONSES — replaces a single `take: 50_000` findMany
  // with repeated smaller reads, so at most one batch's worth of full
  // SurveyResponse rows (each carrying a `Json` answers blob) is ever held
  // in memory at once. `id` (uuidv7, time-ordered) is the cursor field;
  // `orderBy` includes it as a tiebreaker after `submittedAt` so the cursor
  // is stable even when multiple responses share a submittedAt millisecond.
  private async *iterateResponsesForExport(
    tx: Prisma.TransactionClient,
    needId: string,
    surveyLinkId?: string,
  ): AsyncGenerator<SurveyResponse[]> {
    const where = { needId, ...(surveyLinkId ? { surveyLinkId } : {}) };
    let cursor: { id: string } | undefined;
    let fetched = 0;
    while (fetched < MAX_EXPORTABLE_RESPONSES) {
      const take = Math.min(EXPORT_BATCH_SIZE, MAX_EXPORTABLE_RESPONSES - fetched);
      const batch = await tx.surveyResponse.findMany({
        where,
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        take,
        ...(cursor ? { cursor, skip: 1 } : {}),
      });
      if (batch.length === 0) return;
      yield batch;
      fetched += batch.length;
      const last = batch[batch.length - 1];
      if (!last) return;
      cursor = { id: last.id };
      if (batch.length < take) return;
    }
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

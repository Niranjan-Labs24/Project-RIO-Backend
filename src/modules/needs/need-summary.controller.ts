import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { RequirePermission } from '../../common/guards/permission.guard';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import {
  ConfirmNeedSummariesBody,
  UpdateNeedSummaryBody,
  type ConfirmNeedSummariesDto,
  type UpdateNeedSummaryDto,
} from './need-summary.contract';
import { NeedSummaryService } from './need-summary.service';
import type { NeedSummary } from './need-summary.types';

/**
 * RIO-AI-003 routes.
 *
 * Permission split, per the client's 25 Aug 2026 answer on who does what:
 *
 *  - **Generation has no route at all.** The AC says the summary is
 *    "automatically suggested", so it is a system action triggered by the Need
 *    write paths — nobody clicks Generate. Only `regenerate` is user-initiated.
 *  - **read → `aiReview:read`.** Anyone who can see the need can see its
 *    suggested summary and the original beside it.
 *  - **regenerate / edit / confirm → `aiReview:approve`.**
 *
 * That last one deserves an explanation, because `aiReview:write` would look
 * like the natural grant for "edit".
 *
 * The ticket names exactly one role — Human Reviewer — and its criteria say
 * the summary is "editable by the reviewer" and "requires explicit reviewer
 * confirmation". In ROLE_MATRIX, human_reviewer holds aiReview `read` +
 * `approve` and NOT `write`; `write` belongs to Research Officer and Data
 * Analyst. Gating the edit on `write` would therefore have produced the exact
 * inversion of the AC: the two roles the ticket never mentions could edit the
 * summary, and the one role it does name could not.
 *
 * The alternative — adding `write` to human_reviewer — was rejected because
 * aiReview:write is not summary-specific: it also authorises
 * override-domain, manual-classify and retry-classification. Widening it here
 * would hand the reviewer three unrelated classification powers as a side
 * effect of a summarisation ticket.
 */
@Controller()
export class NeedSummaryController {
  constructor(private readonly summaries: NeedSummaryService) {}

  // The reviewer queue. Declared before `needs/:needId/summary` is irrelevant
  // here (different prefix), but it is the route the Reviewer SLA nav links to.
  @Get('need-summaries/pending')
  @RequirePermission('aiReview', 'read')
  listPending(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ items: NeedSummary[]; total: number }> {
    return this.summaries.listPending(
      limit ? Number(limit) : undefined,
      offset ? Number(offset) : undefined,
    );
  }

  @Get('needs/:needId/summary')
  @RequirePermission('aiReview', 'read')
  getForNeed(@Param('needId', new UuidParamPipe()) needId: string): Promise<NeedSummary | null> {
    return this.summaries.getForNeed(needId);
  }

  @Post('needs/:needId/summary/regenerate')
  @RequirePermission('aiReview', 'approve')
  regenerate(@Param('needId', new UuidParamPipe()) needId: string): Promise<NeedSummary> {
    return this.summaries.regenerate(needId);
  }

  @Patch('need-summaries/:summaryId')
  @RequirePermission('aiReview', 'approve')
  updateDraft(
    @Param('summaryId', new UuidParamPipe()) summaryId: string,
    @Body(new TypeBoxValidationPipe(UpdateNeedSummaryBody)) body: UpdateNeedSummaryDto,
  ): Promise<NeedSummary> {
    return this.summaries.updateDraft(summaryId, body.summaryText);
  }

  @Post('need-summaries/:summaryId/confirm')
  @RequirePermission('aiReview', 'approve')
  confirm(
    @Param('summaryId', new UuidParamPipe()) summaryId: string,
  ): Promise<NeedSummary> {
    return this.summaries.confirm(summaryId);
  }

  // Bulk confirm for the queue — a 50-row import otherwise costs the reviewer
  // 50 separate confirmations. Each id is still confirmed individually inside
  // the service, so every row keeps its own audit entry.
  @Post('need-summaries/confirm-batch')
  @RequirePermission('aiReview', 'approve')
  confirmMany(
    @Body(new TypeBoxValidationPipe(ConfirmNeedSummariesBody)) body: ConfirmNeedSummariesDto,
  ): Promise<{ confirmed: string[]; skipped: string[] }> {
    return this.summaries.confirmMany(body.summaryIds);
  }
}

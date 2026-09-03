import { BadRequestException, Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../common/guards/permission.guard';
import { UuidParamPipe } from '../../common/pipes/uuid-param.pipe';
import { TypeBoxValidationPipe } from '../../contract/validation.pipe';
import {
  BulkAcceptBody,
  DecideDuplicateBody,
  ListDuplicatesQuery,
  ListMergesQuery,
  MergeNeedsBody,
  UndoMergeBody,
  ListFlagsQuery,
  ReviewFlagBody,
  type BulkAcceptDto,
  type DecideDuplicateDto,
  type ListDuplicatesQueryDto,
  type ListMergesQueryDto,
  type MergeNeedsDto,
  type UndoMergeDto,
  type ListFlagsQueryDto,
  type ReviewFlagDto,
} from './data-cleaning.contract';
import {
  DuplicateReviewService,
  type DuplicateCandidateItem,
} from './duplicate-review.service';
import { FlagReviewService, type FlagListItem } from './flag-review.service';
import {
  NeedMergeService,
  type MergeHistoryItem,
  type MergePreview,
} from './need-merge.service';

/**
 * RIO-FR-002 — the Data Quality reviewer queue.
 *
 * `dataQuality:read` sees the queue and the per-source report;
 * `dataQuality:approve` decides a flag, which WRITES the correction onto the
 * record. Q23 puts that authority with System Admin and Data Analyst.
 */

// Rules whose proposals are DETERMINISTIC — the same reformat every time,
// with no judgement in them. Only these may be bulk-accepted.
//
// The list is a deny-by-default allowlist rather than a "confidence is null"
// check alone, because a future rule could produce an unscored proposal that
// is still a judgement. Both guards run: the service also refuses any flag
// carrying a confidence score.
const BULK_ACCEPTABLE_RULES = new Set([
  'DATE_FORMAT',
  'PHONE_FORMAT',
  'NUMBER_FORMAT',
  'UNIT_MISMATCH',
]);

@Controller('data-quality')
export class DataCleaningController {
  constructor(
    private readonly review: FlagReviewService,
    private readonly duplicates: DuplicateReviewService,
    private readonly merges: NeedMergeService,
  ) {}

  @Get('flags')
  @RequirePermission('dataQuality', 'read')
  listFlags(
    @Query(new TypeBoxValidationPipe(ListFlagsQuery)) query: ListFlagsQueryDto,
  ): Promise<{ items: FlagListItem[]; total: number }> {
    // Validated as digit strings by the schema — see its comment for why they
    // cannot be Integers. Converted here so the service takes real numbers.
    const { page, pageSize, ...filters } = query;
    return this.review.list({
      ...filters,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  /** Q14's "report per source showing what was flagged". */
  @Get('summary')
  @RequirePermission('dataQuality', 'read')
  summary(): ReturnType<FlagReviewService['summary']> {
    return this.review.summary();
  }

  @Post('flags/:flagId/review')
  @RequirePermission('dataQuality', 'approve')
  reviewFlag(
    @Param('flagId', new UuidParamPipe()) flagId: string,
    @Body(new TypeBoxValidationPipe(ReviewFlagBody)) body: ReviewFlagDto,
  ): Promise<FlagListItem> {
    return this.review.review(flagId, body.decision, body.note);
  }

  @Post('flags/bulk-accept')
  @RequirePermission('dataQuality', 'approve')
  bulkAccept(
    @Body(new TypeBoxValidationPipe(BulkAcceptBody)) body: BulkAcceptDto,
  ): Promise<{ accepted: number; skipped: number }> {
    if (!BULK_ACCEPTABLE_RULES.has(body.ruleCode)) {
      // A village near-match or a vocabulary guess is a judgement about one
      // specific record. Bulk-accepting those would be a reviewer approving
      // hundreds of decisions they never saw, which is the opposite of what
      // Q11's propose-only rule is for.
      throw new BadRequestException({
        error: {
          code: 'RULE_NOT_BULK_ACCEPTABLE',
          message:
            'Only deterministic reformats can be accepted in bulk. This rule proposes a match that has to be confirmed one record at a time.',
        },
      });
    }
    return this.review.bulkAccept(body.ruleCode, body.source, body.note);
  }

  // ── Q40's shared duplicate queue ────────────────────────────────────────
  //
  // Same permission as the findings queue, and deliberately the same
  // controller: the client asked for ONE reviewer-facing surface for both
  // FR-002's literal candidates and AI-004's semantic ones, not two.

  @Get('duplicates')
  @RequirePermission('dataQuality', 'read')
  listDuplicates(
    @Query(new TypeBoxValidationPipe(ListDuplicatesQuery)) query: ListDuplicatesQueryDto,
  ): Promise<{ items: DuplicateCandidateItem[]; total: number }> {
    const { page, pageSize, ...filters } = query;
    return this.duplicates.list({
      ...filters,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Post('duplicates/:candidateId/decide')
  @RequirePermission('dataQuality', 'approve')
  decideDuplicate(
    @Param('candidateId', new UuidParamPipe()) candidateId: string,
    @Body(new TypeBoxValidationPipe(DecideDuplicateBody)) body: DecideDuplicateDto,
  ): Promise<DuplicateCandidateItem> {
    return this.duplicates.decide(candidateId, body.decision, body.note);
  }

  // ── RIO-AI-004: merge ───────────────────────────────────────────────────

  /**
   * What a merge WOULD do. Read-only, and gated on `read` rather than
   * `approve`: seeing the consequences of a merge is not performing one, and a
   * reviewer without approve rights should still be able to understand what
   * the queue is proposing.
   */
  @Get('merges/preview')
  @RequirePermission('dataQuality', 'read')
  previewMerge(
    @Query('survivorNeedId', new UuidParamPipe()) survivorNeedId: string,
    @Query('retiredNeedId', new UuidParamPipe()) retiredNeedId: string,
  ): Promise<MergePreview> {
    return this.merges.preview(survivorNeedId, retiredNeedId);
  }

  /** Merge history, including undone merges (Q24). */
  @Get('merges')
  @RequirePermission('dataQuality', 'read')
  listMerges(
    @Query(new TypeBoxValidationPipe(ListMergesQuery)) query: ListMergesQueryDto,
  ): Promise<{ items: MergeHistoryItem[]; total: number }> {
    return this.merges.list({
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    });
  }

  @Post('merges')
  @RequirePermission('dataQuality', 'approve')
  merge(
    @Body(new TypeBoxValidationPipe(MergeNeedsBody)) body: MergeNeedsDto,
  ): Promise<{ mergeId: string; transferred: number }> {
    return this.merges.merge(body);
  }

  @Post('merges/:mergeId/undo')
  @RequirePermission('dataQuality', 'approve')
  undoMerge(
    @Param('mergeId', new UuidParamPipe()) mergeId: string,
    @Body(new TypeBoxValidationPipe(UndoMergeBody)) body: UndoMergeDto,
  ): Promise<{ restored: number }> {
    return this.merges.undo(mergeId, body.note);
  }
}

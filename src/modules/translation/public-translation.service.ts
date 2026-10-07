import { DomainsService } from '../domains/domains.service';
import { GeographyService } from '../geography/geography.service';
import { ContactService } from '../contact/contact.service';
import { createHash } from 'node:crypto';
import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { CitizenService } from '../citizen/citizen.service';
import { PublicArchiveService } from '../archive/public-archive.service';
import { TranslationService } from './translation.service';
import type {
  PublicTranslateBatchDto,
  PublicTranslateDto,
  PublicTranslationScope,
} from './public-translation.contract';
import type { TranslateContentResult } from './translation.types';

const ACRONYMS: Record<string, string> = {
  ai: 'AI',
  kpi: 'KPI',
  kpis: 'KPIs',
  id: 'ID',
  ids: 'IDs',
  pct: '%',
  url: 'URL',
  qr: 'QR',
  sla: 'SLA',
  ncnp: 'NCNP',
};
function humanise(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map(
      (word, i) =>
        ACRONYMS[word.toLowerCase()] ??
        (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase()),
    )
    .join(' ')
    .replace(/ %$/, ' (%)');
}

/** Only translate text already released by a public resource's own access checks.
 * This is not an anonymous endpoint for submitting arbitrary prompts or private IDs.
 */
/** An enum value as the public report shows it: `CROSS_DOMAIN_X` →
 *  `Cross domain x`. KEEP IN SYNC with the frontend's public-archive
 *  report-content.tsx humaniseEnum. */
const ENUM_VALUE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
function humaniseEnum(value: string): string {
  const words = value.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function containsPublicText(value: unknown, text: string): boolean {
  if (!text.trim()) return false;
  if (typeof value === 'string') {
    return value.includes(text) || (ENUM_VALUE.test(value) && humaniseEnum(value) === text);
  }
  if (Array.isArray(value)) return value.some((v) => containsPublicText(v, text));
  if (value && typeof value === 'object') {
    // Case-insensitive on the label: the in-app report viewer title-cases a
    // field name ("Priority Status") where humanise() gives "Priority status".
    // Both are the same public field name; an exact match refused one of them.
    const lower = text.toLowerCase();
    return Object.entries(value).some(
      ([key, v]) => humanise(key).toLowerCase() === lower || containsPublicText(v, text),
    );
  }
  return false;
}

/** Total characters (after de-duplication) one batch request may carry. */
export const PUBLIC_BATCH_MAX_CHARS = 20_000;
/** Characters of public text one IP may have translated per window. */
export const BUDGET_CHARS_PER_WINDOW = 60_000;
const BUDGET_WINDOW_SECONDS = 60;

@Injectable()
export class PublicTranslationService {
  constructor(
    private readonly citizen: CitizenService,
    private readonly archive: PublicArchiveService,
    private readonly translation: TranslationService,
    private readonly domains: DomainsService,
    private readonly geography: GeographyService,
    private readonly contact: ContactService,
    private readonly redis: RedisService,
  ) {}

  /** The public resource a scope names, loaded through its own access checks. */
  private async loadSource(scope: PublicTranslationScope): Promise<unknown> {
    if (scope.type === 'reference') {
      return Promise.all([
        this.domains.listActiveNames(),
        this.geography.listRegions(),
        this.geography.listGovernorates(),
        this.geography.listCenters(),
        this.contact.listOrganizations(),
      ]);
    }
    if (scope.type === 'survey') return this.citizen.resolveSurvey(scope.token);
    if (scope.type === 'archive-list') return this.archive.list();
    if (scope.type === 'archive-document') return this.archive.document(scope.id);
    return this.archive.detail(scope.kind, scope.id);
  }

  /** Same rule as translate(), per entry: text that is not part of the
   *  resource gets null instead of failing the whole batch. The resource is
   *  loaded once, duplicates are translated once, the work is charged to the
   *  caller's per-IP character budget, and the provider is called in batches
   *  rather than once per text. Results keep the input order. */
  async translateBatch(
    body: PublicTranslateBatchDto,
    clientIp: string,
  ): Promise<(TranslateContentResult | null)[]> {
    const distinct = [...new Set(body.texts)];
    const chars = distinct.reduce((n, t) => n + t.length, 0);
    if (chars > PUBLIC_BATCH_MAX_CHARS) {
      throw new BadRequestException({
        error: { code: 'PUBLIC_TRANSLATION_TOO_LARGE', message: 'Too much text in one request.' },
      });
    }
    const source = await this.loadSource(body.scope);
    const allowed = distinct.filter((t) => containsPublicText(source, t));
    await this.chargeBudget(
      clientIp,
      allowed.reduce((n, t) => n + t.length, 0),
    );
    const translated = await this.translation.translateMany(allowed, body.targetLocale);
    const byText = new Map(allowed.map((t, i) => [t, translated[i]!]));
    return body.texts.map((t) => byText.get(t) ?? null);
  }

  /** Characters of public text one client IP may submit for translation per
   *  window, counted across requests. Shared counter store when available. */
  private async chargeBudget(clientIp: string, chars: number): Promise<void> {
    if (chars === 0) return;
    const key = `rio:public-translation:budget:${createHash('sha256').update(clientIp).digest('hex')}`;
    let used: number;
    const redis = this.redis.client;
    if (redis) {
      try {
        if (redis.status === 'wait') await redis.connect();
        const result = await redis
          .multi()
          .incrby(key, chars)
          .expire(key, BUDGET_WINDOW_SECONDS, 'NX')
          .exec();
        used = Number(result?.[0]?.[1] ?? chars);
      } catch {
        used = this.chargeLocal(key, chars);
      }
    } else {
      used = this.chargeLocal(key, chars);
    }
    if (used > BUDGET_CHARS_PER_WINDOW) {
      throw new HttpException(
        {
          error: {
            code: 'PUBLIC_TRANSLATION_BUDGET_EXCEEDED',
            message: 'Translation limit reached. Try again shortly.',
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private readonly localBudget = new Map<string, { used: number; resetAt: number }>();
  private chargeLocal(key: string, chars: number): number {
    const now = Date.now();
    const entry = this.localBudget.get(key);
    if (!entry || entry.resetAt <= now) {
      this.localBudget.set(key, { used: chars, resetAt: now + BUDGET_WINDOW_SECONDS * 1000 });
      return chars;
    }
    entry.used += chars;
    return entry.used;
  }

  async translate(body: PublicTranslateDto) {
    const source = await this.loadSource(body.scope);
    if (!containsPublicText(source, body.text)) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_TRANSLATION_SOURCE',
          message: 'Text is not part of this public resource.',
        },
      });
    }
    return this.translation.translate(body.text, body.targetLocale);
  }
}

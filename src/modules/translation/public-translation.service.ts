import { DomainsService } from '../domains/domains.service';
import { GeographyService } from '../geography/geography.service';
import { ContactService } from '../contact/contact.service';
import { BadRequestException, Injectable } from '@nestjs/common';
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
  ai: 'AI', kpi: 'KPI', kpis: 'KPIs', id: 'ID', ids: 'IDs', pct: '%', url: 'URL', qr: 'QR', sla: 'SLA', ncnp: 'NCNP',
};
function humanise(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().split(/\s+/)
    .map((word, i) => ACRONYMS[word.toLowerCase()] ?? (i === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase()))
    .join(' ').replace(/ %$/, ' (%)');
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
    return Object.entries(value).some(([key, v]) =>
      humanise(key) === text || containsPublicText(v, text));
  }
  return false;
}

@Injectable()
export class PublicTranslationService {
  constructor(
    private readonly citizen: CitizenService,
    private readonly archive: PublicArchiveService,
    private readonly translation: TranslationService,
    private readonly domains: DomainsService,
    private readonly geography: GeographyService,
    private readonly contact: ContactService,
  ) {}

  /** The public resource a scope names, loaded through its own access checks. */
  private async loadSource(scope: PublicTranslationScope): Promise<unknown> {
    if (scope.type === 'reference') {
      return Promise.all([this.domains.listActiveNames(), this.geography.listRegions(), this.geography.listGovernorates(), this.geography.listCenters(), this.contact.listOrganizations()]);
    }
    if (scope.type === 'survey') return this.citizen.resolveSurvey(scope.token);
    if (scope.type === 'archive-list') return this.archive.list();
    if (scope.type === 'archive-document') return this.archive.document(scope.id);
    return this.archive.detail(scope.kind, scope.id);
  }

  /** Same rule as translate(), per entry: text that is not part of the
   *  resource gets null instead of failing the whole batch. The resource is
   *  loaded once, and results keep the input order. */
  async translateBatch(body: PublicTranslateBatchDto): Promise<(TranslateContentResult | null)[]> {
    const source = await this.loadSource(body.scope);
    const results: (TranslateContentResult | null)[] = new Array(body.texts.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < body.texts.length) {
        const i = next++;
        const text = body.texts[i] as string;
        if (containsPublicText(source, text)) {
          results[i] = await this.translation.translate(text, body.targetLocale);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, body.texts.length) }, worker));
    return results;
  }

  async translate(body: PublicTranslateDto) {
    const source = await this.loadSource(body.scope);
    if (!containsPublicText(source, body.text)) {
      throw new BadRequestException({ error: {
        code: 'INVALID_TRANSLATION_SOURCE', message: 'Text is not part of this public resource.',
      } });
    }
    return this.translation.translate(body.text, body.targetLocale);
  }
}

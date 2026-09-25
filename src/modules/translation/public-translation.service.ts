import { DomainsService } from '../domains/domains.service';
import { GeographyService } from '../geography/geography.service';
import { ContactService } from '../contact/contact.service';
import { BadRequestException, Injectable } from '@nestjs/common';
import { CitizenService } from '../citizen/citizen.service';
import { PublicArchiveService } from '../archive/public-archive.service';
import { TranslationService } from './translation.service';
import type { PublicTranslateDto } from './public-translation.contract';

const ACRONYMS: Record<string, string> = {
  ai: 'AI', kpi: 'KPI', kpis: 'KPIs', id: 'ID', ids: 'IDs', pct: '%', url: 'URL', qr: 'QR',
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
export function containsPublicText(value: unknown, text: string): boolean {
  if (!text.trim()) return false;
  if (typeof value === 'string') return value.includes(text);
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

  async translate(body: PublicTranslateDto) {
    const scope = body.scope;
    let source: unknown;
    if (scope.type === 'reference') {
      source = await Promise.all([this.domains.listActiveNames(), this.geography.listRegions(), this.geography.listGovernorates(), this.geography.listCenters(), this.contact.listOrganizations()]);
    }
    else if (scope.type === 'survey') source = await this.citizen.resolveSurvey(scope.token);
    else if (scope.type === 'archive-list') source = await this.archive.list();
    else if (scope.type === 'archive-document') source = await this.archive.document(scope.id);
    else source = await this.archive.detail(scope.kind, scope.id);
    if (!containsPublicText(source, body.text)) {
      throw new BadRequestException({ error: {
        code: 'INVALID_TRANSLATION_SOURCE', message: 'Text is not part of this public resource.',
      } });
    }
    return this.translation.translate(body.text, body.targetLocale);
  }
}

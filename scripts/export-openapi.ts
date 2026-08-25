/**
 * Standalone OpenAPI doc exporter (GAP-08 Phase 1).
 *
 * `buildOpenApiDocument()` (src/contract/openapi.ts) is pure — it just reads
 * the hand-maintained ROUTES table plus whatever schemas have been
 * registered in the src/contract/typebox.ts module-level registry via
 * registerSchema(). It does *not* import the *.contract.ts files itself, so
 * without the explicit imports below the registry would be empty and
 * components.schemas would come out as {}.
 *
 * There is no barrel that imports every *.contract.ts today — each one is
 * imported ad hoc by its own controller/service — so this script imports
 * all 19 explicitly, purely for their registerSchema() side effects. No
 * Nest bootstrap (no app, no DB) is needed to build the doc.
 *
 * Run: pnpm openapi:export
 * Output: openapi.json at the repo root (committed as the source of truth;
 * see .github/workflows/ci.yml's drift check).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// Side-effect-only imports: each of these calls registerSchema() at module
// load time. Order doesn't affect the output (getRegisteredSchemas() sorts
// keys below), but keep the list alphabetical by module for easy diffing
// against `find src/modules -name '*.contract.ts'`.
import '../src/modules/ai-decisions/ai-decisions.contract';
import '../src/modules/audit/audit.contract';
import '../src/modules/auth/auth.contract';
import '../src/modules/citizen/citizen.contract';
import '../src/modules/contact/contact.contract';
import '../src/modules/domains/domains.contract';
import '../src/modules/methodology-config/methodology-config.contract';
import '../src/modules/ncnp-report/ncnp-report.contract';
import '../src/modules/ncnp-report-review/ncnp-report-review.contract';
import '../src/modules/needs/needs.contract';
import '../src/modules/organizations/organizations.contract';
import '../src/modules/priority/priority.contract';
import '../src/modules/public-surveys/public-surveys.contract';
import '../src/modules/report-sharing/report-sharing.contract';
import '../src/modules/reports/priority-summary.contract';
import '../src/modules/reports/reports.contract';
import '../src/modules/response-quality/response-quality.contract';
import '../src/modules/roles/roles.contract';
import '../src/modules/sharing/sharing.contract';
import '../src/modules/studies/studies.contract';
import '../src/modules/surveys/surveys.contract';
import '../src/modules/system-logs/system-logs.contract';
import '../src/modules/users/users.contract';

import { buildOpenApiDocument } from '../src/contract/openapi';

// JSON.stringify preserves insertion order for string keys, and the doc's
// only "assembled from many modules" object is components.schemas — sort
// it (and paths, which is also built by iterating an array) so re-running
// this script twice produces byte-identical output regardless of import
// order. This determinism is what lets CI diff openapi.json against a
// fresh regeneration instead of drifting on cosmetic key reordering.
function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted as T;
  }
  return value;
}

function main(): void {
  const doc = buildOpenApiDocument();
  const sorted = sortKeysDeep(doc);
  const json = `${JSON.stringify(sorted, null, 2)}\n`;

  const outPath = path.resolve(__dirname, '..', 'openapi.json');
  fs.writeFileSync(outPath, json, 'utf8');

  const pathCount = Object.keys((doc as { paths?: Record<string, unknown> }).paths ?? {}).length;
  const schemaCount = Object.keys(
    (doc as { components?: { schemas?: Record<string, unknown> } }).components?.schemas ?? {},
  ).length;
  // eslint-disable-next-line no-console
  console.log(`Wrote ${outPath} — ${pathCount} paths, ${schemaCount} registered schemas.`);
}

main();

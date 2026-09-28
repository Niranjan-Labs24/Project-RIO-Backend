import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * PermissionGuard lets a signed-in user through any route that carries no
 * @RequirePermission (see permission.guard.ts). That default is deliberate for a handful of
 * routes (own profile, logout, shared config lookups), but it means a NEW route added
 * without the decorator is silently open to every role.
 *
 * This inventory fails when a route is neither @Public nor @RequirePermission and is not on the
 * reviewed list below, so an addition has to be a conscious decision.
 */
const REVIEWED_ANY_SIGNED_IN_ROUTES = new Set([
  'app.controller.ts GET /',
  'modules/auth/auth.controller.ts GET auth/me',
  'modules/auth/auth.controller.ts POST auth/logout',
  'modules/auth/auth.controller.ts POST auth/consent',
  'modules/auth/auth.controller.ts POST auth/change-password',
  'modules/methodology-config/methodology-config.controller.ts GET methodology-config/versions',
  'modules/organizations/organizations.controller.ts GET organizations/current',
  'modules/reviewer-sla/reviewer-sla.controller.ts GET reviewer-sla/config',
  'modules/reviewer-sla/reviewer-sla.controller.ts GET reviewer-sla/alerts',
  'modules/study-config/study-config.controller.ts GET study-config/study-types',
  'modules/study-config/study-config.controller.ts GET study-config/target-sectors',
  'modules/surveys/surveys.controller.ts GET surveys/public/:id',
  'modules/surveys/surveys.controller.ts POST surveys/public/:id/submit',
  'modules/translation/translation.controller.ts POST translation',
]);

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'generated' ? [] : controllerFiles(full);
    return name.endsWith('.controller.ts') ? [full] : [];
  });
}

const isDecoratorLine = (line: string) => /^\s*@\w+/.test(line);
const isNoise = (line: string) => /^\s*(\/\/|\/\*|\*|$)/.test(line);

function unguardedRoutes(file: string, root: string): string[] {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  const classLine = lines.findIndex((l) => /^export class /.test(l));
  // Only real decorator lines count - comments may mention @Public() in prose.
  const classHeader = lines.slice(0, classLine).filter(isDecoratorLine).join('\n');
  if (/@Public\(/.test(classHeader) || /@RequirePermission\(/.test(classHeader)) return [];
  const prefix = /@Controller\(([^)]*)\)/.exec(source)?.[1]?.replace(/['"\s]/g, '') ?? '';
  const found: string[] = [];
  lines.forEach((line, i) => {
    const route = /^\s*@(Get|Post|Put|Patch|Delete)\(([^)]*)\)/.exec(line);
    if (!route) return;
    const decorators: string[] = [];
    for (let j = i - 1; j >= 0 && (isDecoratorLine(lines[j]!) || isNoise(lines[j]!)); j--) {
      if (isDecoratorLine(lines[j]!)) decorators.push(lines[j]!);
    }
    for (let j = i + 1; j < lines.length && isDecoratorLine(lines[j]!); j++) decorators.push(lines[j]!);
    const joined = decorators.join('\n');
    if (/@Public\(/.test(joined) || /@RequirePermission\(/.test(joined)) return;
    const path = route[2]!.replace(/['"\s]/g, '');
    found.push(`${relative(root, file)} ${route[1]!.toUpperCase()} ${[prefix, path].filter(Boolean).join('/') || '/'}`);
  });
  return found;
}

describe('route permission inventory', () => {
  const root = join(__dirname, '..', '..');
  const unguarded = controllerFiles(root).flatMap((file) => unguardedRoutes(file, root));

  it('finds no signed-in-only route beyond the reviewed list', () => {
    const unexpected = unguarded.filter((r) => !REVIEWED_ANY_SIGNED_IN_ROUTES.has(r));
    expect(unexpected).toEqual([]);
  });

  it('keeps the reviewed list free of routes that no longer exist', () => {
    const stale = [...REVIEWED_ANY_SIGNED_IN_ROUTES].filter((r) => !unguarded.includes(r));
    expect(stale).toEqual([]);
  });
});

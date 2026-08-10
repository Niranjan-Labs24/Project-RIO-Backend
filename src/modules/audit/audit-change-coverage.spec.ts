import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * RIO-FR-007 — "recording the user, timestamp, and before/after value".
 *
 * The actor and timestamp are captured centrally by AuditService.record(), so
 * they cannot be forgotten at a call site. The before/after pair cannot be:
 * only the caller knows what the record looked like beforehand, so every
 * material action has to pass `changes` explicitly — and 67 of the 87 call
 * sites originally did not, which left the audit detail view showing an empty
 * panel for exactly the events an auditor opens it for.
 *
 * This test walks every `audit.record({ ... })` in src/ and fails if one of
 * the material actions omits `changes`. It is a lint rule expressed as a test:
 * it does not check that the values are *correct* (no static check can), only
 * that the pair was not dropped. A new create/edit/approve/share/delete/consent
 * event added without before/after fails here rather than shipping a blank
 * detail view.
 */

/** The actions RIO-FR-007 names as material decisions. */
const MATERIAL_ACTIONS = ['create', 'edit', 'approve', 'share', 'delete', 'consent'];

interface CallSite {
  file: string;
  line: number;
  action: string;
  hasChanges: boolean;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    if (!entry.name.endsWith('.ts')) return [];
    if (entry.name.includes('.spec.')) return [];
    return [full];
  });
}

/** Extracts the balanced `{ ... }` object literal starting at `open`. */
function objectLiteralAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

function callSites(): CallSite[] {
  const found: CallSite[] = [];
  for (const file of sourceFiles(join(process.cwd(), 'src'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/audit\.record\(\s*\{/g)) {
      const open = match.index! + match[0].length - 1;
      const block = objectLiteralAt(source, open);
      // Only literal actions are checkable; a computed action (e.g.
      // `decision === 'approved' ? ... : ...`) is skipped rather than
      // guessed at.
      const action = /action:\s*['"]([a-z_]+)['"]/.exec(block)?.[1];
      if (!action || !MATERIAL_ACTIONS.includes(action)) continue;
      found.push({
        file: file.slice(file.indexOf('src')).replace(/\\/g, '/'),
        line: source.slice(0, open).split('\n').length,
        action,
        // Matches both `changes: [...]` and the `changes` shorthand.
        hasChanges: /\bchanges\b\s*[,:}]/.test(block),
      });
    }
  }
  return found;
}

describe('audit before/after coverage (RIO-FR-007)', () => {
  const sites = callSites();

  it('finds the audit call sites to check', () => {
    // Guards the walker itself: a refactor that renamed `audit.record` would
    // otherwise make this whole suite pass by finding nothing.
    expect(sites.length).toBeGreaterThan(40);
  });

  it('records a before/after pair for every create, edit, approve, share, delete and consent event', () => {
    const missing = sites.filter((s) => !s.hasChanges);
    expect(
      missing.map((s) => `${s.file}:${s.line} (${s.action}) is missing \`changes\``),
    ).toEqual([]);
  });

  it.each(MATERIAL_ACTIONS)('has at least one audited %s event', (action) => {
    // Catches the opposite failure: an action family quietly losing its last
    // call site would make the check above vacuously pass for it.
    expect(sites.some((s) => s.action === action)).toBe(true);
  });
});

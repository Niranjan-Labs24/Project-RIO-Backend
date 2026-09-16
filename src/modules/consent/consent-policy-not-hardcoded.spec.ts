import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Client-confirmed (2026-08-27) — consent policies are "dynamically managed
 * and versioned in V2, not hard-coded", drafted by a System Admin and signed
 * off by a System Reviewer before they reach signup.
 *
 * That is a property of the whole repository, not of one function, and it is
 * easy to undo by accident: `prisma/seed.ts` used to upsert the full policy
 * text with `text` in `update:` as well as `create:`, so every `prisma:seed`
 * run silently replaced whatever had been published through Methodology
 * Configuration and reset which version was active — reverting a
 * reviewer-approved policy with nothing in the audit log to show for it.
 *
 * This is a lint rule expressed as a test. It does not check that the seed is
 * *correct*; it checks that no code path outside the consent module can write
 * policy wording at all, so the next person to add "just one more seed line"
 * fails here instead of in production.
 */

const REPO_ROOT = process.cwd();

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    // `generated` is the Prisma client — machine-written, and its type
    // declarations naturally mention every model and operation.
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(full);
    if (!entry.name.endsWith('.ts')) return [];
    if (entry.name.includes('.spec.')) return [];
    return [full];
  });
}

/** Every write operation Prisma exposes on the consentPolicy model. */
const WRITE_OPS =
  /consentPolicy\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g;

/** The only module allowed to write policy rows, plus the seed's bootstrap. */
const ALLOWED = [
  join('src', 'modules', 'consent', 'consent.service.ts'),
  join('prisma', 'seed.ts'),
];

describe('consent policy wording is not hard-coded (client-confirmed 2026-08-27)', () => {
  it('is written only by ConsentService and the seed bootstrap', () => {
    const offenders: string[] = [];
    for (const dir of ['src', 'prisma', 'scripts']) {
      let files: string[];
      try {
        files = sourceFiles(join(REPO_ROOT, dir));
      } catch {
        continue; // optional directory
      }
      for (const file of files) {
        const relative = file.slice(REPO_ROOT.length + 1);
        if (ALLOWED.some((allowed) => relative === allowed)) continue;
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(WRITE_OPS)) {
          offenders.push(`${relative}: ${match[0]}`);
        }
      }
    }

    // A new write path means some code other than the Consent Policies tab
    // can change what registrants agree to. Route it through
    // ConsentService's workflow instead, so it is reviewed and audited.
    expect(offenders).toEqual([]);
  });

  it('never lets the seed overwrite a policy that already exists', () => {
    const seed = readFileSync(join(REPO_ROOT, 'prisma', 'seed.ts'), 'utf8');

    // `upsert` is the specific regression: its `update:` branch is what used
    // to clobber published wording on every reseed.
    expect(seed).not.toContain('consentPolicy.upsert');
    expect(seed).not.toContain('consentPolicy.update');
    expect(seed).not.toContain('consentPolicy.updateMany');

    // The one permitted write is guarded by a prior existence check.
    expect(seed).toContain('bootstrapConsentPolicies');
    const bootstrap = seed.slice(seed.indexOf('async function bootstrapConsentPolicies'));
    expect(bootstrap).toMatch(/findFirst\(\{\s*where:\s*\{\s*kind\s*\}/);
    expect(bootstrap).toMatch(/if\s*\(existing\)\s*continue/);
  });

  it('carries no real policy prose in the seed — only a labelled placeholder', () => {
    const seed = readFileSync(join(REPO_ROOT, 'prisma', 'seed.ts'), 'utf8');

    // Distinctive sentences from the wording that used to live in this file.
    // Their absence is the point: that text is data now, editable only
    // through Methodology Configuration → Consent Policies.
    for (const phrase of [
      'Welcome to this RIO application',
      'We value your privacy',
      'provided solely for demonstration',
      'We do not sell your information',
    ]) {
      expect(seed).not.toContain(phrase);
    }

    // And what IS there says plainly that it is not a policy.
    expect(seed).toContain('not yet published');
    expect(seed).toContain('v0-placeholder');
  });

  it('covers the citizen survey notice too (RIO-NFR-002)', () => {
    const seed = readFileSync(join(REPO_ROOT, 'prisma', 'seed.ts'), 'utf8');
    // The third kind goes through the identical bootstrap; forgetting it here
    // would leave a fresh database unable to accept any public survey
    // response, since submitResponse requires a live citizen policy.
    expect(seed).toContain('citizen_consent');

    // Its real wording was moved out of the frontend and into the policy
    // table by 20260828010001; the migration is the record of that move, so
    // the phrases below must appear there and nowhere else that renders.
    const migration = readFileSync(
      join(REPO_ROOT, 'prisma', 'migrations', '20260828010001_citizen_consent_policy_content', 'migration.sql'),
      'utf8',
    );
    expect(migration).toContain('Personal Information Consent');
    expect(migration).toContain('citizen_consent');
  });
});

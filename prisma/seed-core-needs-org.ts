// Which organisation the Core Needs seeds attach their studies to.
//
// They were written against the local demo database, so each one named
// admin@demo-ngo.org outright. Any other environment — UAT above all — has
// its own organisations and no demo one, and the seeds stopped at "User
// admin@demo-ngo.org not found" with nothing to do about it short of editing
// the file.
//
// SEED_ORG_EMAIL names the account to attach to instead. It is the NGO Admin
// of the target organisation; the seeds take its orgId and record it as the
// author of what they create, so the studies belong to a real user of that
// organisation rather than to a seeded one.
//
//   SEED_ORG_EMAIL=ngo-admin@testing-org.test pnpm seed:core-needs-verification
//
// Left unset it is the demo account as before, so every existing local
// workflow and the CI pipeline behave exactly as they did.
export const DEMO_ORG_EMAIL = "admin@demo-ngo.org";

/** The account the seeds attach to: SEED_ORG_EMAIL, or the demo admin. */
export function seedOrgEmail(fallback: string = DEMO_ORG_EMAIL): string {
  const v = process.env.SEED_ORG_EMAIL?.trim();
  return v || fallback;
}

/**
 * A second organisation, for the geography seed's cross-organisation case.
 *
 * Unset, that seed's second study is skipped rather than written into the
 * first organisation — two studies in one organisation would not exercise
 * the cross-org rule it exists to cover, and would look like real data that
 * proves something it does not.
 */
export function seedSecondOrgEmail(): string | null {
  const v = process.env.SEED_ORG_EMAIL_2?.trim();
  if (v) return v;
  return process.env.SEED_ORG_EMAIL?.trim() ? null : "admin@riverside-ngo.org";
}

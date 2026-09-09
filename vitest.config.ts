import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vitest 4 uses Oxc by default. Decorator metadata is compiled by SWC
  // below, so disable the default transform explicitly.
  oxc: false,
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['./test/setup-env.ts'],
    // Vitest's 5s default is a unit-test budget, and the e2e specs under
    // test/ are not unit tests: each boots its own Nest app and drives real
    // HTTP against the seeded DB. report-perf-regression.e2e.spec.ts is the
    // clearest case — it asserts a 10s generation budget and two 15s export
    // budgets, and absorbs a documented ~17-22s one-time first-call cost in
    // a warm-up call inside the test body first, so it could never finish
    // inside 5s no matter how fast the code under test was. It was failing
    // on the timeout rather than on any budget it actually measures.
    //
    // 120s clears that worst case (22 + 10 + 15 + 15) with headroom while
    // still bounding a genuinely hung test. The cost is that a hang in a
    // fast unit spec now takes 120s to surface instead of 5s; if that
    // becomes annoying, the fix is `projects` — a short timeout for
    // src/**/*.spec.ts and this one only for test/**/*.spec.ts — rather
    // than trimming this back and re-breaking the e2e specs.
    testTimeout: 120_000,
    // e2e specs share one seeded DB and, in several cases, the same seeded
    // user (admin@demo-ngo.org) — a logout() in one file bumps that user's
    // sessionVersion, which invalidates every outstanding token for them
    // globally, not just that file's own token. Running files in parallel
    // lets one file's logout race another file's still-in-flight login+
    // request against the same user. Serializing file execution removes
    // that race; it doesn't fix per-file test order within a single file.
    fileParallelism: false,
  },
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
    }),
  ],
});

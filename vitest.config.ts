import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    environment: 'node',
    setupFiles: ['./test/setup-env.ts'],
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

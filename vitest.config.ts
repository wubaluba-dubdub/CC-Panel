import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    // argon2id at 64 MiB / t=3 costs roughly a quarter of a second per hash, and
    // several tests drive a full enrolment (one password hash plus ten recovery
    // code hashes). Under vitest's default parallelism those land on the same
    // cores at the same time, so the default 5s ceiling is reached by tests that
    // are working correctly. The delay schedule itself never contributes: the
    // clock and the sleep are injected.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

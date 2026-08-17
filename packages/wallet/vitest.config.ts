import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/__tests__/global-setup.ts'],
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 15_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/__tests__/global-setup.ts'],
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 15_000,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/__tests__/**'], // barrel 与测试基建不计入产品覆盖率
    },
  },
});

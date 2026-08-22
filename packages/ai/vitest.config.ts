import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__test__/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 出口桶文件（纯 re-export）与真实上游集成（无凭证自动 skip）不计入分母
      exclude: ['src/index.ts', 'src/types.ts', 'src/events.ts', 'src/adapters/protocol-adapter.ts', 'src/usage/model-meta.generated.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});

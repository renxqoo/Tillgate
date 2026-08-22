import { defineConfig } from 'vitest/config';

export default defineConfig({
  // workspace 依赖（@tokenlens/errors）经 development 条件直连源码——
  // 测试不经构建产物（与 packages/http 同约定）
  resolve: {
    conditions: ['development'],
  },
  test: {
    include: ['__test__/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 出口桶文件（纯 re-export）不计入分母
      exclude: ['src/index.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});

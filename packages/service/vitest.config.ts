import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // DB 集成单测：CI 慢机满载下往返时延放大，超时对齐 wallet 包 15s 约定
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/index.ts'], // 测试与 barrel 不计入产品覆盖率
      // 资金包门禁（棘轮）：真实产品基线（测试文件不计分母）lines 75.9 / branches 63.6——
      // 阈值压在下沿防回退；拖底（transfer 41 / payg 58 / credit-line 60 分支）补齐后逐级上调至 90/85
      thresholds: { lines: 74, statements: 71, functions: 84, branches: 61 },
    },
  },
});

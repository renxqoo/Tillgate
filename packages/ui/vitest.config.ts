import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 目录结构按总纲 §3 目标树 test/{unit,render,pack}(本包用户指令优先于铁律 14 平铺先例, 见 DESIGN.md)
    include: ['test/{unit,render,pack}/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    coverage: {
      provider: 'v8',
      // 口径(如实申报): 只统计本包手写代码; base-nova 模版生成的 vendored 组件
      // 不计入分母(由 render smoke 与 pack 导入测试兜底), index.ts 为纯再导出桶
      include: [
        'src/cn.ts',
        'src/formatting/**',
        'src/hooks/**',
        'src/components/forms/date-picker.tsx',
        'src/components/forms/form.tsx',
        'src/components/forms/number-field.tsx',
        'src/components/forms/password-input.tsx',
        'src/components/data/data-table.tsx',
        'src/components/data/kpi-card.tsx',
        'src/components/data/money-display.tsx',
        'src/components/data/secret-reveal.tsx',
        'src/components/data/status-pill.tsx',
        'src/components/feedback/confirm-dialog.tsx',
        'src/components/feedback/copy-button.tsx',
        'src/components/feedback/form-dialog.tsx',
        'src/components/feedback/sonner.tsx',
        'src/components/navigation/theme-switcher.tsx',
      ],
      exclude: ['src/index.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});

import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * apps/client 测试配置：server/ BFF 层与 features 纯逻辑（.ts）为默认门禁（node 环境）；
 * 组件渲染测试（.tsx，文件头 @vitest-environment jsdom）为渲染切片。
 * 渲染层不计入覆盖率口径——排除理由：薄装配页（src/app/**）由真实链路
 * e2e 覆盖，交互组件由 jsdom 渲染切片覆盖（同 gateway「e2e 归组独立切片」做法）。
 * react 插件仅测试用：tsconfig 继承 Next 的 jsx:"preserve"（SWC 消费），vitest 侧
 * 由插件转换 .tsx（esbuild.jsx 覆盖在 vite 8/rolldown 下不生效）。
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': join(import.meta.dirname, 'src'),
    },
  },
  test: {
    // bun-vitest 的 ssrTransform 会丢 zod v4 的 `export { z }` 再导出——
    // node_modules 全量外部化,由 bun 运行时原生解析(源码转换不受影响)
    server: {
      deps: {
        external: [/node_modules/],
      },
    },

    include: ['__test__/*.test.ts', '__test__/*.test.tsx'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 15_000,
    coverage: {
      include: ['src/server/**', 'src/config/**', 'src/features/**/*.ts'],
      exclude: ['src/features/**/*.d.ts', 'src/features/shell/types.ts'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});

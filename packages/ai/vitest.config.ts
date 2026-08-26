import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // bun-vitest 的 ssrTransform 会丢 zod v4 的 `export { z }` 再导出——
    // node_modules 全量外部化,由 bun 运行时原生解析(源码转换不受影响)
    server: {
      deps: {
        external: [/node_modules/],
      },
    },

    include: ['__test__/*.test.ts'],
    // 铁律 14：真实凭证上游集成以 *.real.test.ts 文件名区分，默认门禁按文件名排除
    // （含裸 `vitest run`——不依赖 package.json 脚本参数）；test:real 脚本显式覆盖排除运行
    exclude: [...configDefaults.exclude, '__test__/*.real.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 出口桶文件（纯 re-export）与真实上游集成（无凭证自动 skip）不计入分母
      exclude: [
        'src/index.ts',
        'src/types.ts',
        'src/events.ts',
        'src/adapters/protocol-adapter.ts',
      ],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});

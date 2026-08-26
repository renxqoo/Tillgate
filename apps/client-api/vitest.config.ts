import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * 根 .env 加载（real 通道需要 DATABASE_URL/REDIS_URL 等本地凭证；
 * 只补缺不覆盖——进程环境优先，CI 直接注入 env）。bun --env-file 对
 * `bun x` 子进程不透传，故此处自载（老仓 vitest 配置同款语义）。
 */
function loadRootDotEnv(): Record<string, string> {
  const filled: Record<string, string> = {};
  try {
    const raw = readFileSync(join(import.meta.dirname, '..', '..', '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value !== '' && process.env[key] === undefined) filled[key] = value;
    }
  } catch {
    // 无根 .env（CI 形态）——全靠进程环境
  }
  return filled;
}

/**
 * client-api 测试配置：契约测试（app.request + 内存替身）为默认门禁；
 * 真实 PG/Redis 全链走 *.real.test.ts（test:real 通道，默认门禁按文件名排除）。
 * 覆盖率排除 src/index.ts（bootstrap）、src/assembly.ts 与 src/adapters/*
 * （装配根与 PG 集成件需真实基础设施——real 通道覆盖，如实申报不调阈值）。
 */
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
    environment: 'node',
    fileParallelism: false,
    testTimeout: 15_000,
    env: loadRootDotEnv(),
    coverage: {
      include: ['src/**'],
      exclude: ['src/index.ts', 'src/assembly.ts', 'src/adapters/**'],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 85 },
    },
  },
});

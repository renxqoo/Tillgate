import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/** 根 .env 加载（只补缺不覆盖；bun x 不透传 --env-file——billing-recovery/client-journey 同款） */
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

// e2e/admin 归组运行装置：
// 与 gateway/security 归组同院但独立配置——本目录测试从 apps/admin-api 目录用其
// vitest 执行（admin-api 依赖闭包含 identity 等 gateway 闭包没有的包；
// fund-chain 旅程同时装配 gateway，闭包超集关系见该测试头注）：
//   cd apps/admin-api && bun run test:e2e
// 全真装配（真实 PG + identity 签发真 admin 令牌）;文件级串行(资金幂等断言无并发噪声)。
export default defineConfig({
  test: {
    root: __dirname,
    include: ['*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: loadRootDotEnv(),
  },
});

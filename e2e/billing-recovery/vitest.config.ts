import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/** 根 .env 加载（只补缺不覆盖；bun x 不透传 --env-file——client-journey 同款） */
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

// e2e/billing-recovery 归组运行装置（P7：v1 gateway e2e-worker 搬迁）：
// 网关真装配（e2e/gateway/kit 世界）+ worker 全真装配共库;文件级串行
// （三环共享同一世界与 worker 副本——旅程内时序耦合,v1 同套件同款）。
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

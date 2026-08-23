import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/** 根 .env 加载（只补缺不覆盖；bun x 不透传 --env-file——实测确认） */
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

export default defineConfig({
  test: {
    include: ['*.e2e.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    env: loadRootDotEnv(),
  },
});

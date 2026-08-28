import { defineConfig } from 'drizzle-kit';

/**
 * 迁移工具配置。连接串必填、无默认——不藏全局默认。
 *
 * ⚠️ request_logs 自迁移 0040 起是分区母表——禁止对它跑 db:generate。
 */
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required for drizzle-kit (no hidden default by design)');
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
});

import { defineConfig } from 'drizzle-kit';

/**
 * 迁移工具配置。连接串必填、无默认(铁律 3:不藏全局默认;
 * v1 此处兜底本地开发地址是 6 处硬编码之一,DESIGN.md §0.3 / IMPLEMENTATION.md B2)。
 *
 * ⚠️ request_logs 自迁移 0040 起是分区母表——禁止对它跑 db:generate
 * (logs.ts 头注释 / IMPLEMENTATION.md B5)。
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

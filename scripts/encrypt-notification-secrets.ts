/**
 * 一次性迁移：notification_channels.config.secret 明文 → enc:v1 密文（幂等可重跑）。
 * 背景：2026-08-20 加固——写入侧已加密（admin-api-v2），本脚本收口存量明文行。
 * 用法：NODE_OPTIONS='--conditions=development' pnpm -C apps/admin-api-v2 exec tsx \
 *       ../../scripts/encrypt-notification-secrets.ts          # dry-run
 *       ... --apply                                          # 执行
 */
import { randomUUID } from 'node:crypto';
import { and, isNotNull, sql } from 'drizzle-orm';
import { createDb } from '@ai-gateway/db';
import { notificationChannels } from '@ai-gateway/db';
import { encrypt } from '@ai-gateway/core';

const apply = process.argv.includes('--apply');
const key = process.env.ENCRYPTION_KEY;
if (!key) {
  console.error('缺 ENCRYPTION_KEY 环境变量（与渠道 apiKeyEnc 同一密钥）');
  process.exit(1);
}
const db = createDb(process.env.DATABASE_URL!, { poolMax: 2 });

// config.secret 为非空字符串且非 enc: 前缀的行（jsonb 谓词，纯 SQL 侧过滤）
const rows = await db
  .select({ id: notificationChannels.id, config: notificationChannels.config })
  .from(notificationChannels)
  .where(
    and(
      isNotNull(notificationChannels.config),
      sql`${notificationChannels.config} ->> 'secret' is not null
          and ${notificationChannels.config} ->> 'secret' != ''
          and (${notificationChannels.config} ->> 'secret') not like 'enc:%'`,
    ),
  );

console.log(`明文 secret 行数：${rows.length}${apply ? '（执行加密）' : '（dry-run）'}`);
for (const row of rows) {
  const config = (row.config ?? {}) as Record<string, unknown>;
  const secret = String(config.secret);
  const encrypted = encrypt(secret, key);
  if (apply) {
    await db
      .update(notificationChannels)
      .set({ config: { ...config, secret: encrypted } })
      .where(sql`${notificationChannels.id} = ${row.id}`);
  }
  console.log(`  channel=${row.id} secret=${secret.slice(0, 3)}**** → enc:${encrypted.slice(4, 10)}****`);
}
if (apply) console.log('完成（幂等：重跑零行命中）');
await db.$client.end();
void randomUUID;

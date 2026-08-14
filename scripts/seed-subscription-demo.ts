/**
 * 重置订阅演示环境：
 *   - 清空所有套餐（含关联订阅；billing_requests/usage_logs 的 subscription_id 置空保留历史）
 *   - 创建 5 个套餐：个人 lite/pro/max + 企业 Pro/MAX
 *   - 创建 2 个本地登录账号：个人 / 企业（各 ¥1000 余额）
 * 用法：pnpm --filter @ai-gateway/db exec tsx ../../scripts/seed-subscription-demo.ts
 *
 * 说明：这是本地演示账号，密码同时记录在 gitignored 的 ACCOUNTS.md（勿提交真实口令）。
 */
import { createDb } from '@ai-gateway/db';
import { plans, users } from '@ai-gateway/db/schema';
import { sql } from 'drizzle-orm';
import { scrypt as scryptCb, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const scrypt = promisify(scryptCb) as (
  p: string,
  salt: string | Buffer,
  k: number,
  o: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** 与 @ai-gateway/identity hashPassword 同格式：scrypt:N:r:p:<saltHex>:<hashHex> */
async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const N = 1 << 15;
  const r = 8;
  const p = 1;
  const h = await scrypt(plain, salt, 32, { N, r, p, maxmem: 512 * 1024 * 1024 });
  return `scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${h.toString('hex')}`;
}

function loadEnv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const f = resolve(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
      return;
    }
    dir = resolve(dir, '..');
  }
}
loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('✗ DATABASE_URL 未设置');
  process.exit(1);
}

const PLANS = [
  { name: 'lite', sortOrder: 1, price: '50', quotaAmount: '50', allowSeats: false },
  { name: 'pro', sortOrder: 2, price: '150', quotaAmount: '150', allowSeats: false },
  { name: 'max', sortOrder: 3, price: '300', quotaAmount: '300', allowSeats: false },
  { name: 'Pro', sortOrder: 2, price: '150', quotaAmount: '150', allowSeats: true },
  { name: 'MAX', sortOrder: 3, price: '300', quotaAmount: '300', allowSeats: true },
] as const;

const ACCOUNTS = [
  {
    subject: 'person@ai-gateway.local',
    email: 'person@ai-gateway.local',
    displayName: '个人测试用户',
    isEnterprise: false,
    password: 'Person12345',
  },
  {
    subject: 'enterprise@ai-gateway.local',
    email: 'enterprise@ai-gateway.local',
    displayName: '企业测试用户',
    isEnterprise: true,
    password: 'Enterprise12345',
  },
] as const;

async function main(): Promise<void> {
  const db = createDb(DATABASE_URL!);

  // 先算好哈希，避免在事务里做慢 scrypt
  const hashed = await Promise.all(ACCOUNTS.map(async (a) => ({ ...a, passwordHash: await hashPassword(a.password) })));

  await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE billing_requests SET subscription_id = NULL`);
    await tx.execute(sql`UPDATE usage_logs SET subscription_id = NULL`);
    await tx.execute(sql`DELETE FROM user_subscriptions`);
    await tx.execute(sql`DELETE FROM plans`);

    await tx.insert(plans).values(
      PLANS.map((p) => ({
        name: p.name,
        kind: 'subscription',
        sortOrder: p.sortOrder,
        price: p.price,
        periodDays: 30,
        quotaAmount: p.quotaAmount,
        allowSeats: p.allowSeats,
        status: 0,
      })),
    );

    for (const a of hashed) {
      const [u] = await tx
        .insert(users)
        .values({
          issuer: 'local',
          subject: a.subject,
          identityProvider: 'local',
          email: a.email,
          displayName: a.displayName,
          isEnterprise: a.isEnterprise,
          balance: '1000',
          passwordHash: a.passwordHash,
          status: 0,
        })
        .returning({ id: users.id });
      console.log(`✓ 用户 ${a.subject} (id=${u!.id}, 企业=${a.isEnterprise})`);
    }
  });

  const rows = await db.select().from(plans).orderBy(plans.sortOrder, plans.allowSeats);
  console.log('\n已创建的套餐:');
  for (const r of rows) {
    console.log(
      `  - ${r.name.padEnd(6)} sort=${r.sortOrder} ¥${r.price} 额度¥${r.quotaAmount} ${r.allowSeats ? '企业(席位)' : '个人'}`,
    );
  }

  console.log('\n========================================');
  console.log('登录账号（C 端 http://localhost:3001）:');
  for (const a of ACCOUNTS) {
    console.log(`  ${a.isEnterprise ? '企业' : '个人'}: ${a.subject} / ${a.password}`);
  }
  console.log('========================================');

  await db.$client.end();
}

main().catch((e) => {
  console.error('✗ 失败:', e);
  process.exit(1);
});

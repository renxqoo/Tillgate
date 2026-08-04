/**
 * 创建/重置管理员账号（本地登录控制台用）。
 * 用法：pnpm tsx scripts/seed-admin.ts [--password=xxx] [--username=admin]
 * 幂等：存在则更新密码+角色，不存在则创建。
 */
import { createDb } from '@ai-gateway/db';
import { users, rateCards, rateCardCoefficients } from '@ai-gateway/db/schema';
import { eq, and } from 'drizzle-orm';
import { scrypt as scryptCb, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const scrypt = promisify(scryptCb) as (
  p: string, salt: string | Buffer, k: number, o: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const N = 1 << 15, r = 8, p = 1;
  const h = await scrypt(plain, salt, 32, { N, r, p, maxmem: 512 * 1024 * 1024 });
  return `scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${h.toString('hex')}`;
}

// 加载 .env
function loadEnv() {
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

const args = process.argv.slice(2);
const usernameArg = args.find((a) => a.startsWith('--username='));
const passwordArg = args.find((a) => a.startsWith('--password='));
const username = usernameArg ? usernameArg.split('=')[1] : 'admin';
const password = passwordArg ? passwordArg.split('=')[1] : 'Admin@123456';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('✗ DATABASE_URL 未设置');
  process.exit(1);
}

const db = createDb(DATABASE_URL);

async function main() {
  const hash = await hashPassword(password);

  // 确保有「标准」费率卡 + global 系数行
  let card = await db.query.rateCards.findFirst({ where: eq(rateCards.name, '标准') });
  if (!card) {
    const [c] = await db.insert(rateCards).values({ name: '标准', description: '标准定价 1.0x' }).returning();
    card = c;
    await db.insert(rateCardCoefficients).values({ rateCardId: c.id, scope: 'global', coefficient: '1.000' });
    console.log('✓ 创建费率卡「标准」(1.0x)');
  }

  // 建管理员（幂等）
  const existing = await db.query.users.findFirst({ where: and(eq(users.issuer, 'local'), eq(users.subject, username)) });
  if (existing) {
    await db.update(users).set({
      passwordHash: hash,
      role: 1,
      status: 0,
      rateCardId: card.id,
      updatedAt: new Date(),
    }).where(eq(users.id, existing.id));
    console.log(`✓ 管理员「${username}」已更新（id=${existing.id}, role=1, 密码已重置）`);
  } else {
    const [u] = await db.insert(users).values({
      issuer: 'local',
      subject: username,
      identityProvider: 'local',
      displayName: 'Administrator',
      email: `${username}@ai-gateway.local`,
      role: 1,
      status: 0,
      rateCardId: card.id,
      balance: 100_000_000, // ¥100000（开发用）
      passwordHash: hash,
    }).returning();
    console.log(`✓ 管理员「${username}」已创建（id=${u!.id}, role=1）`);
  }

  console.log('\n========================================');
  console.log('登录凭证:');
  console.log(`  用户名: ${username}`);
  console.log(`  密码: ${password}`);
  console.log('========================================');
  console.log('控制台: http://localhost:3000/login');

  await db.$client.end();
}

main().catch((e) => {
  console.error('✗ 失败:', e);
  process.exit(1);
});

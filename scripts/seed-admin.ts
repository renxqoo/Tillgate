/**
 * 创建/重置管理员账号（管理后台登录用，admins 表——与 users 物理隔离）。
 * 用法：bun scripts/seed-admin.ts --password=xxx [--email=admin@ai-gateway.local]
 * 幂等：存在则更新密码，不存在则创建。
 */
import { createDb } from '@ai-gateway/db';
import { admins } from '@ai-gateway/db/schema';
import { eq } from 'drizzle-orm';
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

async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const N = 1 << 15,
    r = 8,
    p = 1;
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
const emailArg = args.find((a) => a.startsWith('--email='));
const passwordArg = args.find((a) => a.startsWith('--password='));
const email = emailArg ? emailArg.split('=')[1] : 'admin@ai-gateway.local';
// 禁止写死默认密码：必须显式提供 --password（或 stdin），否则报错退出。
let password = passwordArg ? passwordArg.split('=')[1] : '';
if (!password) {
  // 允许 stdin 传入（echo "xxx" | ...），便于自动化/CI
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve) => {
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => resolve());
      process.stdin.on('error', () => resolve());
    });
    password = Buffer.concat(chunks).toString('utf8').trim();
  }
}
if (!password || password.length < 8) {
  console.error('✗ 必须通过 --password=<至少8位> 或 stdin 提供管理员密码（禁止默认密码）');
  console.error(
    '  用法：bun scripts/seed-admin.ts --password=YourStrongPass1',
  );
  process.exit(1);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('✗ DATABASE_URL 未设置');
  process.exit(1);
}

const db = createDb(DATABASE_URL);

async function main() {
  const hash = await hashPassword(password);

  const existing = await db.query.admins.findFirst({ where: eq(admins.email, email) });
  if (existing) {
    await db
      .update(admins)
      .set({
        passwordHash: hash,
        status: 0,
        updatedAt: new Date(),
      })
      .where(eq(admins.id, existing.id));
    console.log(`✓ 管理员「${email}」已更新（id=${existing.id}，密码已重置）`);
  } else {
    const [a] = await db
      .insert(admins)
      .values({
        email,
        displayName: 'Administrator',
        passwordHash: hash,
        status: 0,
      })
      .returning();
    console.log(`✓ 管理员「${email}」已创建（id=${a!.id}）`);
  }

  console.log('\n========================================');
  console.log('登录凭证:');
  console.log(`  邮箱: ${email}`);
  console.log(`  密码: ${password}`);
  console.log('========================================');
  console.log('管理后台: http://localhost:3002');

  await db.$client.end();
}

main().catch((e) => {
  console.error('✗ 失败:', e);
  process.exit(1);
});

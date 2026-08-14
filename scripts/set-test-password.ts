/**
 * 一次性脚本：给 org-invite e2e 测试账号设置本地登录密码（供手动登录 C 端复查）。
 * 用法：packages/db/node_modules/.bin/tsx scripts/set-test-password.ts <密码>
 */
import { hashPassword } from '../packages/identity/src/password.js';
import { createDb } from '../packages/db/src/index.js';
import { eq } from 'drizzle-orm';
import { users } from '../packages/db/src/schema/index.js';

const db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
);

const plaintext = process.argv[2];
if (!plaintext) {
  console.error('用法：tsx scripts/set-test-password.ts <密码>');
  process.exit(1);
}

async function main() {
  const hash = await hashPassword(plaintext);
  const targets = await db.query.users.findMany({
    where: eq(users.issuer, 'local'),
    columns: { id: true, email: true },
    orderBy: (t, { desc }) => [desc(t.id)],
    limit: 50,
  });
  const orgUsers = targets.filter((u) => u.email?.endsWith('@e2e.local'));
  if (orgUsers.length === 0) {
    console.log('未找到 @e2e.local 测试账号，未做改动');
    return;
  }
  for (const u of orgUsers.slice(0, 2)) {
    await db.update(users).set({ passwordHash: hash }).where(eq(users.id, u.id));
    console.log(`✓ 已设密码：${u.email}（id=${u.id}）`);
  }
  await db.$client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

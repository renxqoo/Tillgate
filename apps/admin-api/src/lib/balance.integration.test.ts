import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, transactions } from '@ai-gateway/db/schema';
import { changeBalance, recordTransaction, unfreezeIfBadDebt } from './balance.js';

// 加载 monorepo 根 .env（vitest 不自动加载）
const cwd = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(): void {
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    const f = resolve(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
loadEnvFile();

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const db: Db = createDb(DATABASE_URL);

let connected = false;
beforeAll(async () => {
  try {
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

/** 创建测试专用用户（独立余额，不污染 dev 数据） */
async function createTestUser(balance: number, status = 0, freezeReason: string | null = null): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: 'balance-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      identityProvider: 'local',
      displayName: 'Balance Test',
      balance,
      status,
      freezeReason,
    })
    .returning();
  return u!.id;
}
async function cleanupUser(userId: number): Promise<void> {
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe('changeBalance 集成测试（真实 PG）', () => {
  it('普通变更 → 余额 + 流水前后余额一致', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser(1000);
    try {
      const r = await changeBalance(db, uid, 500);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.balanceBefore).toBe(1000);
      expect(r.balanceAfter).toBe(1500);
      await recordTransaction(db, {
        userId: uid,
        type: 'manual',
        amount: 500,
        balanceBefore: r.balanceBefore,
        balanceAfter: r.balanceAfter,
        remark: 'test',
      });
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expect(u?.balance).toBe(1500);
      const txs = await db.select().from(transactions).where(eq(transactions.userId, uid));
      expect(txs).toHaveLength(1);
      expect(txs[0]!.balanceBefore).toBe(1000);
      expect(txs[0]!.balanceAfter).toBe(1500);
    } finally {
      await cleanupUser(uid);
    }
  });

  it('并发 10 次加 100 → 余额准确（原子 UPDATE 不丢更新）', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser(0);
    try {
      await Promise.all(Array.from({ length: 10 }, () => changeBalance(db, uid, 100)));
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expect(u?.balance).toBe(1000); // 10 × 100，无丢失更新
    } finally {
      await cleanupUser(uid);
    }
  });

  it('扣减 + checkSufficient + 余额不足 → 拒绝，余额不变', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser(100);
    try {
      const r = await changeBalance(db, uid, -500, { checkSufficient: true });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('insufficient');
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expect(u?.balance).toBe(100); // 未变
    } finally {
      await cleanupUser(uid);
    }
  });

  it('扣减刚好等于余额 → 成功（边界 = 0）', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser(300);
    try {
      const r = await changeBalance(db, uid, -300, { checkSufficient: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.balanceAfter).toBe(0);
    } finally {
      await cleanupUser(uid);
    }
  });

  it('不存在的用户 → not_found', async () => {
    if (!connected) return it.skip('no DB');
    const r = await changeBalance(db, 999_999_999, 100);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_found');
  });

  it('unfreezeIfBadDebt：坏账冻结用户加钱后自动解冻', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser(0, 1, 'insufficient_balance');
    try {
      await changeBalance(db, uid, 1000);
      await unfreezeIfBadDebt(db, uid);
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expect(u?.balance).toBe(1000);
      expect(u?.freezeReason).toBeNull(); // 坏账原因清除
      // 注意：status 仍为 1（封禁），unfreeze 只清 freezeReason，不解封 status（解封需管理员显式操作）
      expect(u?.status).toBe(1);
    } finally {
      await cleanupUser(uid);
    }
  });

  it('并发扣减：余额 1000，10 个并发各扣 100，全部成功（够用）', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser(1000);
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => changeBalance(db, uid, -100, { checkSufficient: true })),
      );
      const okCount = results.filter((r) => r.ok).length;
      expect(okCount).toBe(10);
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expect(u?.balance).toBe(0);
    } finally {
      await cleanupUser(uid);
    }
  });

  it('并发扣减超额：余额 1000，20 个并发各扣 100 → 只有 10 个成功，余额 0（不透支）', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser(1000);
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => changeBalance(db, uid, -100, { checkSufficient: true })),
      );
      const okCount = results.filter((r) => r.ok).length;
      expect(okCount).toBe(10); // 恰好 10 个成功
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expect(u?.balance).toBe(0); // 不透支
    } finally {
      await cleanupUser(uid);
    }
  });
});

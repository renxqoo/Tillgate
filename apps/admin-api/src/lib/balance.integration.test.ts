import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, transactions } from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { changeBalance, recordTransaction, unfreezeIfBadDebt } from './balance.js';

/**
 * changeBalance 集成测试（重构后：元 + decimal 全精度）。
 * 需要真实 Postgres；无 DB 时 beforeAll 抛错 → 所有 it 自动跳过。
 *
 * 所有金额单位为「元」（DB numeric(38,18)），changeBalance 接受 string。
 * 断言用 Decimal.equals 比较（不依赖字符串表示形式）。
 */

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

async function createTestUser(balance: string, status = 0, freezeReason: string | null = null): Promise<number> {
  const [u] = await db.insert(users).values({
    issuer: 'test',
    subject: 'balance-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    identityProvider: 'local',
    displayName: 'Balance Test',
    balance,
    status,
    freezeReason,
  }).returning();
  return u!.id;
}
async function cleanupUser(uid: number): Promise<void> {
  await db.delete(transactions).where(eq(transactions.userId, uid));
  await db.delete(users).where(eq(users.id, uid));
}

function expectDec(actual: string | undefined, expected: string): void {
  expect(new Decimal(actual ?? '0').equals(new Decimal(expected))).toBe(true);
}

describe('changeBalance 集成测试（真实 PG，元 + decimal）', () => {
  it('普通变更 → 余额 + 流水前后余额一致', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('1'); // 余额 1 元
    try {
      const r = await changeBalance(db, uid, '0.5'); // +0.5 元
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expectDec(r.balanceBefore, '1');
      expectDec(r.balanceAfter, '1.5');
      await recordTransaction(db, {
        userId: uid,
        type: 'manual',
        amount: '0.5',
        balanceBefore: r.balanceBefore,
        balanceAfter: r.balanceAfter,
        remark: 'test',
      });
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expectDec(u?.balance, '1.5');
      const txs = await db.select().from(transactions).where(eq(transactions.userId, uid));
      expect(txs).toHaveLength(1);
      expectDec(txs[0]!.balanceBefore, '1');
      expectDec(txs[0]!.balanceAfter, '1.5');
    } finally {
      await cleanupUser(uid);
    }
  });

  it('并发 10 次加 0.1 → 余额准确（原子 UPDATE 不丢更新）', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('0');
    try {
      await Promise.all(Array.from({ length: 10 }, () => changeBalance(db, uid, '0.1')));
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expectDec(u?.balance, '1'); // 10 × 0.1 = 1 元
    } finally {
      await cleanupUser(uid);
    }
  });

  it('扣减 + checkSufficient + 余额不足 → 拒绝，余额不变', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('0.1'); // 余额 0.1 元
    try {
      const r = await changeBalance(db, uid, '-0.5', { checkSufficient: true }); // 扣 0.5 > 0.1
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toBe('insufficient');
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expectDec(u?.balance, '0.1'); // 未变
    } finally {
      await cleanupUser(uid);
    }
  });

  it('扣减刚好等于余额 → 成功（边界 = 0）', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('0.3');
    try {
      const r = await changeBalance(db, uid, '-0.3', { checkSufficient: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expectDec(r.balanceAfter, '0');
    } finally {
      await cleanupUser(uid);
    }
  });

  it('不存在的用户 → not_found', async () => {
    if (!connected) return it.skip('no DB');
    const r = await changeBalance(db, 999_999_999, '0.1');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_found');
  });

  it('unfreezeIfBadDebt：坏账冻结用户加钱后自动解冻', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('0', 1, 'bad_debt');
    try {
      await changeBalance(db, uid, '1');
      await unfreezeIfBadDebt(db, uid);
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expectDec(u?.balance, '1');
      expect(u?.freezeReason).toBeNull(); // 坏账原因清除
      // 注意：status 仍为 1（封禁），unfreeze 只清 freezeReason，不解封 status
      expect(u?.status).toBe(1);
    } finally {
      await cleanupUser(uid);
    }
  });

  it('B-1：unfreezeIfBadDebt 不清非坏账冻结（manual_review 保留）', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('0', 1, 'manual_review');
    try {
      await changeBalance(db, uid, '1');
      await unfreezeIfBadDebt(db, uid);
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expect(u?.freezeReason).toBe('manual_review'); // 不被误清
    } finally {
      await cleanupUser(uid);
    }
  });

  it('并发扣减：余额 1，10 个并发各扣 0.1，全部成功（够用）', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('1');
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => changeBalance(db, uid, '-0.1', { checkSufficient: true })),
      );
      const okCount = results.filter((r) => r.ok).length;
      expect(okCount).toBe(10);
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expectDec(u?.balance, '0'); // 1 - 10×0.1 = 0
    } finally {
      await cleanupUser(uid);
    }
  });

  it('并发扣减超额：余额 1，20 个并发各扣 0.1 → 只有 10 个成功，余额 0（不透支）', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('1');
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => changeBalance(db, uid, '-0.1', { checkSufficient: true })),
      );
      const okCount = results.filter((r) => r.ok).length;
      expect(okCount).toBe(10); // 恰好 10 个成功
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expectDec(u?.balance, '0'); // 不透支
    } finally {
      await cleanupUser(uid);
    }
  });
});

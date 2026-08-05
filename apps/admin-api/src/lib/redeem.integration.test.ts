import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, transactions, redeemBatches, redeemCodes } from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { redeemCode } from './redeem.js';
import { generateRedeemCode, sha256Hex } from './secrets.js';

/** 余额/金额比较：DB 返回 string，用 Decimal.equals（不依赖字符串表示形式） */
function expectDec(actual: string | undefined, expected: string): void {
  expect(new Decimal(actual ?? '0').equals(new Decimal(expected))).toBe(true);
}

// 加载 monorepo 根 .env
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

async function createTestUser(balance: string): Promise<number> {
  const [u] = await db.insert(users).values({
    issuer: 'test',
    subject: 'redeem-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    identityProvider: 'local',
    displayName: 'Redeem Test',
    balance,
  }).returning();
  return u!.id;
}

async function createBatch(amount: string, count: number, expiresAt: Date | null): Promise<{ batchId: number; codes: string[] }> {
  const codes: string[] = [];
  const rows: Array<{ batchId: number; codeHash: string; expiresAt: Date | null }> = [];
  const [batch] = await db.insert(redeemBatches).values({
    name: 'test-batch-' + Date.now(),
    amount: String(amount),
    total: count,
    usedCount: 0,
    createdBy: 1,
  }).returning();
  for (let i = 0; i < count; i++) {
    const p = generateRedeemCode();
    codes.push(p);
    rows.push({ batchId: batch!.id, codeHash: sha256Hex(p), expiresAt });
  }
  await db.insert(redeemCodes).values(rows);
  return { batchId: batch!.id, codes };
}

async function cleanup(userId: number, batchId: number): Promise<void> {
  await db.delete(redeemCodes).where(eq(redeemCodes.batchId, batchId));
  await db.delete(redeemBatches).where(eq(redeemBatches.id, batchId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe('redeemCode 充值码兑换（真实 PG）', () => {
  it('正常兑换 → 余额增加 + 流水', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('0');
    const { batchId, codes } = await createBatch('5', 1, null);
    try {
      const r = await redeemCode(db, uid, codes[0]!);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expectDec(r.amount, '5');
      expectDec(r.balanceBefore, '0');
      expectDec(r.balanceAfter, '5');
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expectDec(u?.balance, '5');
      const txs = await db.select().from(transactions).where(eq(transactions.userId, uid));
      expect(txs).toHaveLength(1);
      expect(txs[0]!.type).toBe('redeem');
      expectDec(txs[0]!.amount, '5');
    } finally {
      await cleanup(uid, batchId);
    }
  });

  it('重复兑换同一码 → code_already_used（并发安全）', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('0');
    const { batchId, codes } = await createBatch('5', 1, null);
    try {
      const first = await redeemCode(db, uid, codes[0]!);
      expect(first.ok).toBe(true);
      const second = await redeemCode(db, uid, codes[0]!);
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.code).toBe('code_already_used');
      // 余额只加一次
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expectDec(u?.balance, '5');
    } finally {
      await cleanup(uid, batchId);
    }
  });

  it('并发兑换同一码 → 只有 1 个成功（原子条件 UPDATE 防双花）', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('0');
    const { batchId, codes } = await createBatch('5', 1, null);
    try {
      const results = await Promise.all([redeemCode(db, uid, codes[0]!), redeemCode(db, uid, codes[0]!)]);
      const okCount = results.filter((r) => r.ok).length;
      expect(okCount).toBe(1); // 双花防护
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expectDec(u?.balance, '5'); // 只加一次
    } finally {
      await cleanup(uid, batchId);
    }
  });

  it('不存在的码 → invalid_code', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('0');
    try {
      const r = await redeemCode(db, uid, 'RC-NONEXISTENT1234567890ABCDEFGH');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe('invalid_code');
    } finally {
      await db.delete(users).where(eq(users.id, uid));
    }
  });

  it('过期码 → code_expired', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('0');
    const { batchId, codes } = await createBatch('5', 1, new Date(Date.now() - 86400_000)); // 昨天过期
    try {
      const r = await redeemCode(db, uid, codes[0]!);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe('code_expired');
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expectDec(u?.balance, '0'); // 未加
    } finally {
      await cleanup(uid, batchId);
    }
  });

  it('作废码 → code_revoked', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('0');
    const { batchId, codes } = await createBatch('5', 1, null);
    try {
      // 手动作废
      await db.update(redeemCodes).set({ status: 2 }).where(eq(redeemCodes.codeHash, sha256Hex(codes[0]!)));
      const r = await redeemCode(db, uid, codes[0]!);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe('code_revoked');
    } finally {
      await cleanup(uid, batchId);
    }
  });

  it('两张不同码各兑换一次 → 余额累计', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('1');
    const { batchId, codes } = await createBatch('3', 2, null);
    try {
      const r1 = await redeemCode(db, uid, codes[0]!);
      const r2 = await redeemCode(db, uid, codes[1]!);
      expect(r1.ok && r2.ok).toBe(true);
      const u = await db.query.users.findFirst({ where: eq(users.id, uid) });
      expectDec(u?.balance, '7'); // 1 + 3 + 3
    } finally {
      await cleanup(uid, batchId);
    }
  });

  // R-1：batch 缺失时不应静默 0 元入账（资损防御）
  // 注：DB 有 FK 约束（redeem_codes.batch_id → redeem_batches.id），孤儿 code 不可能通过正常操作产生。
  // 但代码层仍需防御（防 migration/手动 SQL 产生孤儿）。此测试验证代码逻辑：batch 查询为空时抛错。
  it('R-1 代码防御：batch 查询返回空 → 抛 batch_not_found（非静默 0 元）', async () => {
    // 用 mock 验证纯逻辑（绕过 FK 约束）
    const mockTx = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: () => Promise.resolve([{ id: 999, batchId: 999999998 }]), // code 命中
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]), // batch 查不到 → 空
          }),
        }),
      }),
      insert: () => ({ values: () => ({ onConflictDoNothing: () => ({}) }) }),
    };
    const mockDb = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx),
    } as never;
    await expect(redeemCode(mockDb, 1, 'dummy-code')).rejects.toThrow(/batch/);
  });

  // R-2：同一 code 重复兑换只产生一条流水（幂等保护）
  it('重复兑换同一码 → transactions 只有一条流水（幂等）', async () => {
    if (!connected) return it.skip('no DB');
    const uid = await createTestUser('0');
    const { batchId, codes } = await createBatch('5', 1, null);
    try {
      await redeemCode(db, uid, codes[0]!);
      // 尝试再次兑换（会被条件 UPDATE 拦截，返回 code_already_used）
      await redeemCode(db, uid, codes[0]!);
      const txs = await db.select().from(transactions).where(eq(transactions.userId, uid));
      expect(txs).toHaveLength(1); // 只有一条流水
    } finally {
      await cleanup(uid, batchId);
    }
  });
});

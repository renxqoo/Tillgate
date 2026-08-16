import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  redeemCodes,
  redeemBatches,
  users,
  admins,
  transactions,
  fundOperations,
} from '@ai-gateway/db/schema';
import { createEphemeralRedis, loadRootEnvFile, type EphemeralRedis } from '@ai-gateway/http';

import { redeemRoutes } from '../redeem.js';
import { makeClientTestApp, makeServices } from '../../test/helpers.js';

/**
 * POST /api/redeem 兑换路径的特征测试（服务层抛错重构的护栏）：
 *   - 无效码 → 400 REDEEM_INVALID_CODE；成功 → 200 + 到账
 *   - 限流 → 429 RATE_LIMITED + retry-after（真实 Redis 计数）
 * 数据纪律：rdfl- 前缀，finally 只删自建行（含 ledger 衍生 fund_operations/transactions）。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
let redis: EphemeralRedis;

let connected = false;
beforeAll(async () => {
  try {
    redis = await createEphemeralRedis();
    await db.select({ id: users.id }).from(users).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await redis?.close();
  await db.$client.end().catch(() => {});
});

const ts = `${Date.now()}`;

async function setupUser(): Promise<number> {
  const [u] = await db
    .insert(users)
    .values({ issuer: 'local', subject: `rdfl-u-${ts}-${randomUUID().slice(0, 8)}`, identityProvider: 'local', balance: '0' })
    .returning({ id: users.id });
  return u!.id;
}

function makeApp(uid: number) {
  return makeClientTestApp(uid, { '/redeem': redeemRoutes(makeServices(db, { redis })) });
}

function redeemReq(app: ReturnType<typeof makeApp>, code: string) {
  return app.request('/api/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

/** 建 admin+batch+未用码（status=0），返回清理句柄 */
async function setupCode(amount: string): Promise<{
  code: string;
  cleanup: () => Promise<void>;
}> {
  const code = `rdfl-${randomUUID()}`;
  const [admin] = await db
    .insert(admins)
    .values({ email: `rdfl-admin-${ts}@test.local`, displayName: `rdfl-admin-${ts}`, passwordHash: randomUUID(), status: 0 })
    .returning({ id: admins.id });
  const [batch] = await db
    .insert(redeemBatches)
    .values({ name: `rdfl 批次 ${ts}`, amount, total: 10, createdBy: admin!.id })
    .returning({ id: redeemBatches.id });
  const [row] = await db
    .insert(redeemCodes)
    .values({ batchId: batch!.id, codeHash: createHash('sha256').update(code).digest('hex'), status: 0 })
    .returning({ id: redeemCodes.id });
  return {
    code,
    cleanup: async () => {
      await db.delete(redeemCodes).where(eq(redeemCodes.id, row!.id)).catch(() => {});
      await db.delete(redeemBatches).where(eq(redeemBatches.id, batch!.id)).catch(() => {});
      await db.delete(admins).where(eq(admins.id, admin!.id)).catch(() => {});
    },
  };
}

/** 只删自建数据：fund_operations 按（codeHash, uid）拼出的 operationId 精确匹配 */
async function cleanupUser(uid: number, codes: string[] = []): Promise<void> {
  await db.delete(transactions).where(eq(transactions.userId, uid)).catch(() => {});
  for (const c of codes) {
    const operationId = `redeem:${createHash('sha256').update(c).digest('hex')}:${uid}`;
    await db.delete(fundOperations).where(eq(fundOperations.operationId, operationId)).catch(() => {});
  }
  await db.delete(users).where(eq(users.id, uid)).catch(() => {});
  await redis.del(`redeem:rl:${uid}`).catch(() => {});
}

describe('POST /api/redeem（特征测试）', () => {
  it('无效码 → 400 REDEEM_INVALID_CODE；有效码 → 200 + 到账', async (ctx) => {
    if (!connected) return ctx.skip();
    const uid = await setupUser();
    const { code, cleanup } = await setupCode('12.34');
    try {
      const app = makeApp(uid);

      const bad = await redeemReq(app, 'rdfl-not-exist');
      expect(bad.status).toBe(400);
      expect(await errCode(bad)).toBe('REDEEM_INVALID_CODE');

      const ok = await redeemReq(app, code);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { ok: boolean; amount: string; balanceAfter: string };
      expect(body.ok).toBe(true);
      expect(Number(body.amount)).toBe(12.34);
      expect(Number(body.balanceAfter)).toBe(12.34);

      // 幂等：同用户重复兑同码 → 重放首次结果（200，不重复入账）
      const replay = await redeemReq(app, code);
      expect(replay.status).toBe(200);
      const replayBody = (await replay.json()) as { balanceAfter: string };
      expect(Number(replayBody.balanceAfter)).toBe(12.34);

      // 换个用户兑已用的码 → 409 已被使用
      const other = await setupUser();
      const stolen = await redeemReq(makeApp(other), code);
      expect(stolen.status).toBe(409);
      expect(await errCode(stolen)).toBe('REDEEM_CODE_ALREADY_USED');
      await cleanupUser(other);
    } finally {
      await cleanup();
      await cleanupUser(uid, [code, 'rdfl-not-exist']);
    }
  });

  it('超过 10 次/分钟 → 429 RATE_LIMITED + retry-after', async (ctx) => {
    if (!connected) return ctx.skip();
    const uid = await setupUser();
    try {
      const app = makeApp(uid);
      let limited: Response | null = null;
      for (let i = 0; i < 12; i++) {
        const res = await redeemReq(app, 'rdfl-not-exist');
        if (i < 10) {
          expect(res.status).toBe(400);
        } else {
          limited = res;
        }
      }
      expect(limited).not.toBeNull();
      expect(limited!.status).toBe(429);
      expect(await errCode(limited!)).toBe('RATE_LIMITED');
      expect(limited!.headers.get('retry-after')).not.toBeNull();
    } finally {
      await cleanupUser(uid);
    }
  });
});

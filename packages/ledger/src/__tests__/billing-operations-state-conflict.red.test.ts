import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { billingRequests, users } from '@ai-gateway/db/schema';
import { BillingOperationError, createBillingOperations } from '../index.js';

/**
 * 审计 P0-6：resolveUncertain(provider_receipt_recovered) 的 UPDATE 按
 * revision CAS 可能命中 0 行（findFirst 与 UPDATE 之间状态被并发事务移动），
 * 但返回 `{ ...changed! }` 展开 undefined → 假成功：回执被静默丢弃、
 * 审计记录谎报成功、该单永不结算。兄弟分支（retryDead/abandonDead）都有
 * `if (!row) throw state_conflict` 守卫，唯独此分支漏掉。
 *
 * 复现（确定性行锁交错）：
 *   tx2 持该行 FOR UPDATE 锁 → resolveUncertain 的 findFirst 照常读到
 *   uncertain@rev1（READ COMMITTED 快照）→ 其 UPDATE 阻塞在 tx2 行锁 →
 *   tx2 提交 released@rev2 → tx1 的 UPDATE 重新评估 WHERE revision=1
 *   → 0 行命中。
 */
const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
);
let connected = false;

beforeAll(async () => {
  try {
    await db.query.users.findFirst({ columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('resolveUncertain — 0 行命中守卫', () => {
  it('CAS 过期（并发移动状态）必须抛 state_conflict（不得假成功）', async () => {
    if (!connected) return it.skip('no DB');
    const tag = randomUUID().slice(0, 8);
    const [user] = await db
      .insert(users)
      .values({
        issuer: 'test',
        subject: randomUUID(),
        identityProvider: 'local',
        email: `p06-${tag}@test.local`,
        passwordHash: 'x',
        status: 0,
      })
      .returning({ id: users.id });
    const requestId = randomUUID();
    try {
      await db.insert(billingRequests).values({
        requestId,
        userId: user!.id,
        status: 'uncertain',
        revision: 1,
        authorizationFingerprint: `p06-${tag}`,
        reservedAmount: '0.01',
        planReservedAmount: '0',
        quote: {
          maxOutputTokens: 100,
          explicitlyFree: false,
          candidates: [
            {
              mappingId: 1,
              externalModel: 'm',
              realModel: 'm',
              inputPrice: '0.000001',
              outputPrice: '0.000002',
              cacheInputPrice: '0',
              coefficient: '1',
              inputTokenUpperBound: 10,
              billingPolicyFingerprint: null,
            },
          ],
        },
      });
      const receipt = {
        requestId,
        userId: user!.id,
        usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, estimated: false },
        inputPrice: '0.000001',
        outputPrice: '0.000002',
        cacheInputPrice: '0',
        coefficient: '1',
        durationMs: 100,
        stream: false,
        streamAborted: false,
        mappingId: 1,
        billingPolicyFingerprint: null,
        realModel: 'm',
        externalModel: 'm',
        channelId: 1,
        channelKey: 'k',
        apiKeyId: 1,
        appId: null,
        credentialType: 'api_key',
      };
      const operations = createBillingOperations({ db });

      // tx2：先锁行，等 resolveUncertain 的 UPDATE 阻塞后再移动状态提交
      const competing = db.transaction(async (tx) => {
        await tx.execute(sql`select 1 from billing_requests where request_id = ${requestId} for update`);
        await sleep(600);
        await tx
          .update(billingRequests)
          .set({ status: 'released', revision: 2, updatedAt: sql`clock_timestamp()` })
          .where(eq(billingRequests.requestId, requestId));
      });
      await sleep(150); // 让 resolveUncertain 先完成 findFirst（读到 uncertain@rev1）
      const result = await operations
        .resolveUncertain({
          operationId: `p06-op-${tag}`,
          requestId,
          expectedRevision: 1,
          adminId: null,
          actor: 'system',
          decision: 'provider_receipt_recovered',
          receipt: receipt as never,
          reason: 'p06 test',
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
      await competing;

      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error).toBeInstanceOf(BillingOperationError);
      expect(result.ok === false && (result.error as BillingOperationError).code).toBe(
        'state_conflict',
      );
      // 行状态保持并发事务写入的终值，未被假成功污染
      const [after] = await db
        .select({ status: billingRequests.status, revision: billingRequests.revision })
        .from(billingRequests)
        .where(eq(billingRequests.requestId, requestId));
      expect(after?.status).toBe('released');
      expect(after?.revision).toBe(2);
    } finally {
      await db.delete(billingRequests).where(eq(billingRequests.requestId, requestId));
      await db.delete(users).where(eq(users.id, user!.id));
    }
  });
});

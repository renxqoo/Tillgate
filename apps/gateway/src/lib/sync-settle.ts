import { eq, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { usageLogs, transactions, users } from '@ai-gateway/db/schema';
import { calcAmount, PRICE_PER_MILLION } from '@ai-gateway/money';

/**
 * 同步降级结算（资损防线：meter 入队失败时的 DB 兜底）。
 *
 * 场景：Redis 挂 → BullMQ 入队失败 → worker 收不到 job → 漏扣。
 * 修复：gateway 在 enqueueMeter 失败时，直接在请求路径内调用 syncSettle（DB 原子扣费）。
 *
 * 幂等保障（与 worker settle 共享）：
 *   - usage_logs.request_id 唯一约束：INSERT ON CONFLICT DO NOTHING + returning() 判定首次
 *   - transactions (ref_type='usage_logs', ref_id) 部分唯一索引：双保险
 *   → Redis 恢复后 worker 收到同一 job 也会跳过（已结算），不重复扣费
 *
 * 与 worker settle 的区别：不刷 Redis 缓存 / 不清 hold / 不回填 TPM（Redis 不可用时这些无意义）。
 */
export interface SyncSettleData {
  requestId: string;
  userId: number;
  apiKeyId: number | null;
  appId: number | null;
  credentialType: string;
  externalModel: string;
  realModel: string;
  channelId: number | null;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; estimated: boolean };
  inputPrice: number;
  outputPrice: number;
  cacheInputPrice: number;
  coefficient: number;
  coefficientMilli: number;
  durationMs: number;
  stream: boolean;
  streamAborted: boolean;
  holdAmount: number;
  mappingId: number;
}

export async function syncSettle(
  db: Db,
  data: SyncSettleData,
): Promise<{ settled: boolean; amount: number }> {
  const amount = calcAmount({
    inputTokens: data.usage.inputTokens,
    cachedInputTokens: data.usage.cachedInputTokens,
    outputTokens: data.usage.outputTokens,
    inputPrice: data.inputPrice,
    cacheInputPrice: data.cacheInputPrice,
    outputPrice: data.outputPrice,
    coefficientMilli: data.coefficientMilli,
  });
  const upstreamCost = Math.max(0, Math.round(
    (Math.max(0, data.usage.inputTokens - data.usage.cachedInputTokens) * data.inputPrice +
      data.usage.cachedInputTokens * data.cacheInputPrice +
      data.usage.outputTokens * data.outputPrice) /
      PRICE_PER_MILLION,
  ));

  let settled = false;
  await db.transaction(async (tx) => {
    const inserted = await tx.insert(usageLogs).values({
      requestId: data.requestId,
      userId: data.userId,
      appId: data.appId,
      apiKeyId: data.apiKeyId,
      credentialType: data.credentialType,
      externalModel: data.externalModel,
      realModel: data.realModel,
      channelId: data.channelId,
      inputTokens: data.usage.inputTokens,
      cachedInputTokens: data.usage.cachedInputTokens,
      outputTokens: data.usage.outputTokens,
      tokensEstimated: data.usage.estimated,
      inputPrice: data.inputPrice,
      outputPrice: data.outputPrice,
      cacheInputPrice: data.cacheInputPrice,
      coefficient: data.coefficient.toFixed(3),
      amount,
      upstreamCost,
      planAmount: 0,
      paygAmount: amount,
      billedBy: 'payg',
      durationMs: data.durationMs,
      status: 0,
      stream: data.stream,
      streamAborted: data.streamAborted,
    }).onConflictDoNothing({ target: usageLogs.requestId }).returning({ id: usageLogs.id });

    if (inserted.length === 0) return; // 已结算（幂等跳过）
    settled = true;

    // 原子扣余额
    const updated = await tx.update(users)
      .set({ balance: sql`${users.balance} - ${amount}`, updatedAt: new Date() })
      .where(eq(users.id, data.userId))
      .returning({ balance: users.balance });
    const newBalance = updated[0]?.balance ?? 0;

    await tx.insert(transactions).values({
      userId: data.userId,
      type: 'consume',
      amount: -amount,
      balanceBefore: newBalance + amount,
      balanceAfter: newBalance,
      refType: 'usage_logs',
      refId: data.requestId,
      remark: `${data.externalModel} (${data.usage.inputTokens}+${data.usage.outputTokens} tokens) [sync]`,
    }).onConflictDoNothing({
      target: [transactions.refType, transactions.refId],
      where: sql`ref_type = 'usage_logs'`,
    });
  });

  return { settled, amount };
}

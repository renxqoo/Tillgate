import { eq, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { usageLogs, transactions, users } from '@ai-gateway/db/schema';
import { Decimal, calcAmount, toDecimal, toStorage } from '@ai-gateway/money';

/**
 * 同步降级结算（资损防线：meter 入队失败时的 DB 兜底）。
 * 重构后：元 + decimal 全精度。
 *
 * 幂等保障（与 worker settle 共享）：usage_logs.request_id 唯一 + transactions 部分唯一索引。
 * 与 worker settle 的区别：不删 Redis hold / 不回填 TPM（Redis 不可用时这些无意义）。
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
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  coefficient: string;
  durationMs: number;
  stream: boolean;
  streamAborted: boolean;
  holdAmount: string;
  mappingId: number;
}

export async function syncSettle(
  db: Db,
  data: SyncSettleData,
): Promise<{ settled: boolean; amount: string; overdraft: boolean }> {
  const amountDec = calcAmount({
    inputTokens: data.usage.inputTokens,
    cachedInputTokens: data.usage.cachedInputTokens,
    outputTokens: data.usage.outputTokens,
    inputPrice: data.inputPrice,
    cacheInputPrice: data.cacheInputPrice,
    outputPrice: data.outputPrice,
    coefficient: data.coefficient,
  });
  const amount = toStorage(amountDec);

  const upstreamCostDec = (() => {
    const inputTokens = Math.max(0, data.usage.inputTokens);
    const cached = Math.min(Math.max(0, data.usage.cachedInputTokens), inputTokens);
    const uncached = inputTokens - cached;
    const base = toDecimal(data.inputPrice)
      .times(uncached)
      .plus(toDecimal(data.cacheInputPrice).times(cached))
      .plus(toDecimal(data.outputPrice).times(Math.max(0, data.usage.outputTokens)));
    const cost = base.div(1_000_000);
    return cost.lt(0) ? new Decimal(0) : cost;
  })();
  const upstreamCost = toStorage(upstreamCostDec);

  let settled = false;
  let overdraft = false;
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
      coefficient: toDecimal(data.coefficient).toFixed(3),
      amount,
      upstreamCost,
      planAmount: '0',
      paygAmount: amount,
      billedBy: 'payg',
      durationMs: data.durationMs,
      status: 0,
      stream: data.stream,
      streamAborted: data.streamAborted,
    }).onConflictDoNothing({ target: usageLogs.requestId }).returning({ id: usageLogs.id });

    if (inserted.length === 0) return;
    settled = true;

    // 原子扣实际费用（sync-settle 是 Redis 宕机时的兜底，此时无法可靠判定 hold 标记状态，
    // 故不退 hold——hold 若存在会由 worker 后续重试结算时处理，或 TTL 过期自然释放）。
    const updated = await tx.update(users)
      .set({ balance: sql`${users.balance} - ${amount}`, updatedAt: new Date() })
      .where(eq(users.id, data.userId))
      .returning({ balance: users.balance });

    const newBalance = updated[0]?.balance ?? '0';
    const balanceBefore = toStorage(toDecimal(newBalance).plus(amountDec));
    if (toDecimal(newBalance).lt(0)) overdraft = true;

    await tx.insert(transactions).values({
      userId: data.userId,
      type: 'consume',
      amount: toStorage(amountDec.negated()),
      balanceBefore,
      balanceAfter: newBalance,
      refType: 'usage_logs',
      refId: data.requestId,
      remark: `${data.externalModel} (${data.usage.inputTokens}+${data.usage.outputTokens} tokens) [sync]${overdraft ? ' [OVERDRAFT-余额为负]' : ''}`,
    }).onConflictDoNothing({
      target: [transactions.refType, transactions.refId],
      where: sql`ref_type = 'usage_logs'`,
    });
  });

  return { settled, amount, overdraft };
}

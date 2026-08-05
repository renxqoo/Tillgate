import { eq, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { usageLogs, transactions, users } from '@ai-gateway/db/schema';
import { Decimal, calcAmount, toDecimal, toStorage } from '@ai-gateway/money';
import type { Redis } from 'ioredis';

/**
 * 计量 job 数据（与 gateway MeterProducer.MeterJobData 结构一致）。
 * 重构后：价格/系数用元+小数（废除 coefficientMilli）。
 */
export interface MeterJobData {
  requestId: string;
  userId: number;
  apiKeyId: number | null;
  appId: number | null;
  credentialType: string;
  externalModel: string;
  realModel: string;
  channelId: number | null;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number; estimated: boolean };
  /** 价格快照（元/百万 token，string，来自 model_mappings numeric 列） */
  inputPrice: string;
  outputPrice: string;
  cacheInputPrice: string;
  /** 费率卡系数（小数，如 1.0） */
  coefficient: string;
  durationMs: number;
  stream: boolean;
  streamAborted: boolean;
  /** 预扣金额（元，string，worker 结算时对账用） */
  holdAmount: string;
  mappingId: number;
}

/**
 * 结算：算实际费用（decimal 全精度）→ 写 usage_logs + transactions + 原子扣余额 → 删 hold 标记。
 *
 * 幂等与并发安全（资损防线）：
 *   - 全部在单事务内：INSERT usage_logs ON CONFLICT DO NOTHING + returning() 判定是否首次
 *   - transactions 部分唯一索引 (ref_type='usage_logs', ref_id) 双保险
 *   - 余额用原子条件 UPDATE（SET balance = balance - amount），无需 FOR UPDATE 行锁
 *
 * 精度（重构后）：amount/upstreamCost 全程 Decimal，账本永不 round。
 */
export async function settle(
  db: Db,
  redis: Redis,
  data: MeterJobData,
): Promise<{ settled: boolean; amount: string; overdraft: boolean }> {
  // 1. 算实际费用（money 包公式，decimal 全精度，已防御异常 usage）
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

  // 上游成本估算（官方价 × 实际用量，无系数——供应商对账数据基础，decimal 全精度不 round）
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

  // 2. 单事务：写明细 + 流水 + 原子扣余额
  let settled = false;
  let overdraft = false;
  await db.transaction(async (tx) => {
    // 2a. 写 usage_logs（幂等：request_id 唯一，冲突跳过；returning 判定是否首次写入）
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
      status: 0, // 成功已计费（透支也如实扣，余额可为负 = 用户欠款）
      stream: data.stream,
      streamAborted: data.streamAborted,
    }).onConflictDoNothing({ target: usageLogs.requestId }).returning({ id: usageLogs.id });

    // 非首次（已结算）→ 跳过 transactions + 余额更新（幂等）
    if (inserted.length === 0) return;

    settled = true;

    // 2b. 退 hold 预扣：仅当 hold 标记仍存在时退（标记存在 = hold 未被 release/reclaim，
    //     仍在 DB 占用余额）。GETDEL 原子取+删，防与 release/reclaim 竞态双退。
    //     标记格式 "userId:amount"；取不到（已释放/回收/从未 hold）→ refund=0。
    let refund = '0';
    try {
      const held = (await redis.getdel(`billing:hold:${data.requestId}`)) as string | null;
      if (held) {
        const m = /^\d+:(.+)$/.exec(held);
        if (m) refund = m[1]!;
      }
    } catch {
      // Redis 不可用：无法判定 hold 是否仍在 → 不退（保守，防双退；hold TTL 会自然过期释放占位）
    }
    // 原子扣余额：退 hold 预扣 + 扣实际费用（防双扣）。net = amount - refund。
    const updated = await tx.update(users)
      .set({ balance: sql`${users.balance} + ${refund}::numeric - ${amount}`, updatedAt: new Date() })
      .where(eq(users.id, data.userId))
      .returning({ balance: users.balance });

    const newBalance = updated[0]?.balance ?? '0';
    // balanceBefore = newBalance - refund + amount（反推扣减前余额：扣减 = refund - amount）
    const balanceBefore = toStorage(toDecimal(newBalance).plus(amountDec).minus(refund));

    if (toDecimal(newBalance).lt(0)) overdraft = true;

    // 2c. 写 transactions（资金流水；幂等：ref 部分唯一索引冲突跳过）
    await tx.insert(transactions).values({
      userId: data.userId,
      type: 'consume',
      amount: toStorage(amountDec.negated()),
      balanceBefore,
      balanceAfter: newBalance,
      refType: 'usage_logs',
      refId: data.requestId,
      remark: `${data.externalModel} (${data.usage.inputTokens}+${data.usage.outputTokens} tokens)${overdraft ? ' [OVERDRAFT-余额为负-欠款待充值抵扣]' : ''}`,
    }).onConflictDoNothing({
      target: [transactions.refType, transactions.refId],
      where: sql`ref_type = 'usage_logs'`,
    });
  });

  // 3. 删 hold 标记（无论是否首次结算都删，防残留；幂等 DEL 无副作用）。
  //    余额缓存已不存在（重构后 DB 权威），无需 DEL balance 缓存。
  try {
    await redis.del(`billing:hold:${data.requestId}`);
  } catch {
    // Redis 不可用：hold TTL 兜底
  }

  // 4. TPM 回填：实际 token 数累加到分钟桶（仅首次结算，避免重试翻倍）
  if (settled) {
    const totalTokens = Math.max(0, data.usage.inputTokens) + Math.max(0, data.usage.outputTokens);
    const minute = Math.floor(Date.now() / 60_000);
    const tpmDims = [`user:${data.userId}`, `model:${data.mappingId}`];
    if (data.apiKeyId) tpmDims.push(`key:${data.apiKeyId}`);
    if (data.appId) tpmDims.push(`app:${data.appId}`);
    for (const dim of tpmDims) {
      const key = `tpm:${dim}:${minute}`;
      await redis.incrby(key, totalTokens);
      await redis.expire(key, 120);
    }
  }

  return { settled, amount, overdraft };
}

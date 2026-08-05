import { eq, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { usageLogs, transactions, users } from '@ai-gateway/db/schema';
import { calcAmount, PRICE_PER_MILLION } from '@ai-gateway/money';
import type { Redis } from 'ioredis';

/**
 * 计量 job 数据（与 gateway MeterProducer.MeterJobData 结构一致）。
 * worker 不直接 import gateway（app 间不互相依赖），这里定义等价接口契约。
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

/**
 * 结算：算实际费用 → 写 usage_logs + transactions + 原子扣余额 → 刷 Redis 缓存。
 *
 * 幂等与并发安全（资损防线）：
 *   - 全部在单事务内：INSERT usage_logs ON CONFLICT DO NOTHING + returning() 判定是否首次
 *     → 非首次（已结算）直接跳过 transactions/余额更新，杜绝重试/并发重复扣费
 *   - transactions 部分唯一索引 (ref_type='usage_logs', ref_id) 双保险
 *   - 余额用原子条件 UPDATE（SET balance = balance - amount），无需 FOR UPDATE 行锁
 *     PG 单条 UPDATE 天然原子，并发不丢更新
 */
export async function settle(
  db: Db,
  redis: Redis,
  data: MeterJobData,
): Promise<{ settled: boolean; amount: number; overdraft: boolean }> {
  // 1. 算实际费用（money 包公式，已防御异常 usage）
  const amount = calcAmount({
    inputTokens: data.usage.inputTokens,
    cachedInputTokens: data.usage.cachedInputTokens,
    outputTokens: data.usage.outputTokens,
    inputPrice: data.inputPrice,
    cacheInputPrice: data.cacheInputPrice,
    outputPrice: data.outputPrice,
    coefficientMilli: data.coefficientMilli,
  });
  // 上游成本估算（官方价 × 实际用量，无系数——供应商对账数据基础）
  const upstreamCost = Math.max(0, Math.round(
    ((Math.max(0, data.usage.inputTokens - data.usage.cachedInputTokens)) * data.inputPrice +
      data.usage.cachedInputTokens * data.cacheInputPrice +
      data.usage.outputTokens * data.outputPrice) /
      PRICE_PER_MILLION,
  ));

  // 2. 单事务：写明细 + 流水 + 原子扣余额
  //    幂等靠 INSERT ... ON CONFLICT DO NOTHING + returning()：首次返回行，重复返回空
  let settled = false;
  let overdraft = false;
  let balanceAfter: number | null = null;
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
      coefficient: data.coefficient.toFixed(3),
      amount,
      upstreamCost,
      planAmount: 0,
      paygAmount: amount,
      billedBy: 'payg',
      durationMs: data.durationMs,
      status: 0, // 成功已计费
      stream: data.stream,
      streamAborted: data.streamAborted,
    }).onConflictDoNothing({ target: usageLogs.requestId }).returning({ id: usageLogs.id });

    // 非首次（已结算）→ 跳过 transactions + 余额更新（幂等）
    if (inserted.length === 0) return;

    settled = true;

    // 2b. 原子扣余额：SET balance = balance - amount WHERE balance >= amount RETURNING balance
    //    条件 UPDATE 防透支：余额不足时不扣（returning 空）→ 标 overdraft，usage_logs 已记真实 amount 供对账追回。
    //    PG 单条 UPDATE 内完成读-改-写 + 条件判定，并发事务串行化执行（不丢更新，无需 FOR UPDATE）。
    //    fail-open 路径（Redis 不可用时 hold 跳过放行）的资损兜底：余额绝不为负。
    const updated = await tx.update(users)
      .set({ balance: sql`${users.balance} - ${amount}`, updatedAt: new Date() })
      .where(sql`${users.id} = ${data.userId} and ${users.balance} >= ${amount}`)
      .returning({ balance: users.balance });

    if (updated.length === 0) {
      // 透支：余额 < amount（fail-open 放行后实际用量超余额）→ 不扣（保余额非负），
      // usage_logs 已写真实 amount（对账/追回依据）。流水仍记，balanceAfter = 当前余额。
      overdraft = true;
      const cur = await tx.query.users.findFirst({
        where: eq(users.id, data.userId),
        columns: { balance: true },
      });
      balanceAfter = cur?.balance ?? 0;
      await tx.insert(transactions).values({
        userId: data.userId,
        type: 'consume',
        amount: -amount,
        balanceBefore: balanceAfter,
        balanceAfter,
        refType: 'usage_logs',
        refId: data.requestId,
        remark: `${data.externalModel} (${data.usage.inputTokens}+${data.usage.outputTokens} tokens) [OVERDRAFT-资损待追回]`,
      }).onConflictDoNothing({
        target: [transactions.refType, transactions.refId],
        where: sql`ref_type = 'usage_logs'`,
      });
      return;
    }

    const newBalance = updated[0]?.balance ?? 0;
    const balanceBefore = newBalance + amount; // 扣前 = 扣后 + 本次扣额

    balanceAfter = newBalance;

    // 2c. 写 transactions（资金流水；幂等：ref 部分唯一索引冲突跳过）
    await tx.insert(transactions).values({
      userId: data.userId,
      type: 'consume',
      amount: -amount,
      balanceBefore,
      balanceAfter: newBalance,
      refType: 'usage_logs',
      refId: data.requestId,
      remark: `${data.externalModel} (${data.usage.inputTokens}+${data.usage.outputTokens} tokens)`,
    }).onConflictDoNothing({
      target: [transactions.refType, transactions.refId],
      where: sql`ref_type = 'usage_logs'`,
    });
  });

  // 3. 已结算 → 失效 Redis 余额缓存 + 清 hold + TPM 回填
  if (settled && balanceAfter !== null) {
    // 失效缓存（而非覆盖）：并发 hold 期间，redis.set(dbBalance) 会抹掉其他请求的 hold 占位，
    // 导致虚高余额 → 超额放行（资损）。改为 DEL：下次 hold 走 cache_miss → 从 DB 懒加载权威值，
    // 此时 DB 已扣减（本事务已提交），新 hold 基于真实余额判定，不破坏进行中 hold 的占位。
    await redis.del(`billing:balance:${data.userId}`);
  }
  // 无论是否首次结算，都清 hold key（防残留；幂等 DEL 无副作用）
  await redis.del(`billing:hold:${data.requestId}`);

  // 4. TPM 回填：实际 token 数累加到分钟桶（gateway checkTpm 读它做预占判断）
  //    仅首次结算时回填（避免重试导致 TPM 翻倍）
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

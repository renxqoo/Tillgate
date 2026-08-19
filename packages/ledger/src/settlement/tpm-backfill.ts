import type { Redis } from 'ioredis';
import type { UsageReceipt } from '../rating/types.js';

/**
 * TPM 回填（拆自 settle.ts，行为零变更）：结算提交后的 best-effort 投影，不参与资金事务。
 * 预占与实际归属是两套维度——预占 hash 每维释放；实际用量只记收据归属维
 * （failover 试过的渠道/模型不计入 actual，防虚增误触发限流）。
 */
export async function backfillTpm(redis: Redis | null, data: UsageReceipt): Promise<void> {
  if (!redis) return;
  const inputTokens = Math.max(0, data.usage.inputTokens);
  const cachedInput = Math.min(Math.max(0, data.usage.cachedInputTokens), inputTokens);
  const totalTokens = inputTokens - cachedInput + Math.max(0, data.usage.outputTokens);
  const dimensions = [`user:${data.userId}:model:${data.mappingId}`, `model:${data.mappingId}`];
  if (data.apiKeyId) dimensions.push(`key:${data.apiKeyId}`);
  if (data.appId) dimensions.push(`app:${data.appId}`);
  if (data.channelId) dimensions.push(`channel:${data.channelId}`);
  try {
    const minute = Math.floor(Date.now() / 60_000);
    // 语义（口径单一真相）：预占与实际归属是两件事——
    //   1) 预占 hash 里的**每个**维度都要释放（hold 全放，不管谁承接）；
    //   2) 实际用量只记 **KEYS[3..]**（收据归属维度：成功 mapping/channel
    //      + user×成功model + key/app）——hash 里可能累积候选尝试的全部维度
    //      （failover 切走的主模型、试过即弃的渠道），把它们计入 actual 会
    //      虚增未承接维度的消耗、误触发其限流。
    // 预占丢失（hash 空/Redis 降级后结算）时同样按收据维度记账，行为统一。
    const script = `
      if redis.call('EXISTS', KEYS[2]) == 1 then
        return 0
      end
      local values = redis.call('HGETALL', KEYS[1])
      for i = 1, #values, 2 do
        local reservedKey = values[i]
        local current = tonumber(redis.call('GET', reservedKey) or '0')
        local amount = tonumber(values[i + 1])
        redis.call('SET', reservedKey, tostring(math.max(0, current - amount)), 'EX', 600)
      end
      redis.call('SET', KEYS[2], '1', 'EX', 86400)
      for i = 3, #KEYS do
        redis.call('INCRBY', KEYS[i], tonumber(ARGV[1]))
        redis.call('EXPIRE', KEYS[i], 600)
      end
      redis.call('DEL', KEYS[1])
      return 1
    `;
    const actualKeys = dimensions.map((dimension) => `{tpm}:actual:${minute}:${dimension}`);
    await redis.eval(
      script,
      actualKeys.length + 2,
      `{tpm}:request:${data.requestId}`,
      `{tpm}:projected:${data.requestId}`,
      ...actualKeys,
      totalTokens,
    );
  } catch {
    // Redis 故障只影响限流参考投影。
  }
}

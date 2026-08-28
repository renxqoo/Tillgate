/**
 * 预扣策略读取（装配面适配器）：system_configs KV `billing_reservation_policy` 的
 * 进程内 TTL 缓存读。写路径走 admin-api settings → control-plane 用例（本进程只读）；
 * admin 改动在 TTL 内被全网关拾取，无需重启。
 *
 * fail 语义分两层：KV 读失败抛错（fail-loud——与计费时区同款：策略事故不得静默
 * 回落错档预扣；同库 DB 不可达时 authorize 本就走不通，无额外可用性损失）；
 * KV 缺失/值域异常回落 full（保守全额预扣——fail-closed，绝不把垃圾值当 fixed
 * 放行垫付）。并发读合并为单飞行，避免缓存击穿放大查询。
 */
import { eq } from 'drizzle-orm';
import type { DbLike } from '@tillgate/db';
import { systemConfigs } from '@tillgate/db';
import {
  BILLING_RESERVATION_LIMIT_KEY,
  BILLING_RESERVATION_POLICY_KEY,
  DEFAULT_RESERVATION_LIMIT,
  parseReservationLimitSetting,
  parseReservationPolicySetting,
  type FundingReservationPolicy,
} from '@tillgate/billing';

export interface BillingReservationPolicyEnv {
  db: DbLike;
  /** 缓存 TTL ms（过期后下一请求刷新；admin 改动的拾取延迟上界） */
  ttlMs: number;
}

/** 预扣策略读取器（billing-port 每次 authorize 消费） */
export function createBillingReservationPolicyReader(
  env: BillingReservationPolicyEnv,
): () => Promise<FundingReservationPolicy> {
  let cached: FundingReservationPolicy | null = null;
  let cachedAt = 0;
  let inflight: Promise<FundingReservationPolicy> | null = null;
  return async () => {
    if (cached != null && Date.now() - cachedAt < env.ttlMs) return cached;
    if (inflight == null) {
      inflight = (async () => {
        const row = await env.db.query.systemConfigs.findFirst({
          where: eq(systemConfigs.key, BILLING_RESERVATION_POLICY_KEY),
          columns: { value: true },
        });
        // 值域解析复用 billing 单一实现：缺失/垃圾 = full 保守预扣
        const policy = parseReservationPolicySetting(row?.value) ?? { mode: 'full' as const };
        cached = policy;
        cachedAt = Date.now();
        return policy;
      })().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };
}


/** 单笔预估敞口上限读取器（同款 TTL 缓存；缺失/垃圾回落缺省 1000——保守拒大） */
export function createBillingReservationLimitReader(
  env: BillingReservationPolicyEnv,
): () => Promise<string> {
  let cached: string | null = null;
  let cachedAt = 0;
  let inflight: Promise<string> | null = null;
  return async () => {
    if (cached != null && Date.now() - cachedAt < env.ttlMs) return cached;
    if (inflight == null) {
      inflight = (async () => {
        const row = await env.db.query.systemConfigs.findFirst({
          where: eq(systemConfigs.key, BILLING_RESERVATION_LIMIT_KEY),
          columns: { value: true },
        });
        const limit = parseReservationLimitSetting(row?.value) ?? DEFAULT_RESERVATION_LIMIT;
        cached = limit;
        cachedAt = Date.now();
        return limit;
      })().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };
}

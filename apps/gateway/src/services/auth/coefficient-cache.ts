import type { Db } from '@ai-gateway/db';
import type { Redis } from 'ioredis';
import { rateCardCoefficientsCache } from '@ai-gateway/http';
import {
  loadRateCardCoefficients,
  type RateCardCoefficientSnapshot,
} from '@ai-gateway/ledger';

/**
 * 费率卡系数快照缓存（热路径，60s TTL）。
 *
 * resolve 步每个请求要按「选中的映射」解析系数（model>group>global），快照来自
 * ledger/coefficient.ts（单一真相）。整卡行数少，整快照缓存一次查询覆盖所有候选。
 *
 * 语义与 key-auth-cache 一致：
 *   - TTL 60s——管理端改系数/停用卡最长 60s 生效（卡停用由 resolve 步拒绝）
 *   - fail-open：Redis 不可用降级直查 DB
 *   - null（卡不存在/未绑卡）不缓存，直接返回 null（无 DB 放大风险：卡 ID 来自鉴权快照）
 */

const TTL_S = 60;

export interface CoefficientCache {
  getSnapshot(rateCardId: number | null): Promise<RateCardCoefficientSnapshot | null>;
}

export function createCoefficientCache(db: Db, redis: Redis): CoefficientCache {
  return {
    async getSnapshot(rateCardId) {
      if (rateCardId == null) return null;
      const key = rateCardCoefficientsCache(rateCardId);
      try {
        const cached = await redis.get(key);
        if (cached !== null) return JSON.parse(cached) as RateCardCoefficientSnapshot;
      } catch {
        // Redis 不可用 → fail-open 查 DB
      }
      const snapshot = await loadRateCardCoefficients(db, rateCardId);
      if (snapshot) {
        try {
          await redis.set(key, JSON.stringify(snapshot), 'EX', TTL_S);
        } catch {
          // 写失败不影响本次结果
        }
      }
      return snapshot;
    },
  };
}

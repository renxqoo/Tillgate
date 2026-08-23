/**
 * 计费时区读取（装配面适配器）：system_configs KV `billing_timezone` 的进程内
 * TTL 缓存读。全系统统一一个计费时区（schedule 分时段策略的墙钟口径）；
 * 写路径走 admin-api settings → control-plane 用例（本进程只读）。
 *
 * fail-loud：KV 读失败抛错（时区配置事故不得静默回落错档计价）——与目录读
 * 同库，DB 不可达时请求本就走不通，无额外可用性损失。缺省值与 TTL 由 config
 * 注入（零写死）；并发读合并为单飞行，避免缓存击穿放大查询。
 */
import { eq } from 'drizzle-orm';
import type { DbLike } from '@tokenlens/db';
import { systemConfigs } from '@tokenlens/db';

/** system_configs 键（与 control-plane settings 读写用例共用同一约定） */
export const BILLING_TIMEZONE_CONFIG_KEY = 'billing_timezone';

interface BillingTimezoneShape {
  timezone?: unknown;
}

async function readTimezoneOnce(db: DbLike): Promise<string | null> {
  const row = await db.query.systemConfigs.findFirst({
    where: eq(systemConfigs.key, BILLING_TIMEZONE_CONFIG_KEY),
    columns: { value: true },
  });
  const shape = (row?.value ?? null) as BillingTimezoneShape | null;
  return typeof shape?.timezone === 'string' && shape.timezone.length > 0 ? shape.timezone : null;
}

export interface BillingTimezoneEnv {
  db: DbLike;
  /** 缓存 TTL ms（过期后下一请求刷新；分钟粒度选价无需强一致） */
  ttlMs: number;
  /** KV 未配置时的回落时区（IANA 名；config 层已验合法性） */
  fallback: string;
}

/** 计费时区读取器（catalog-port 每请求消费） */
export function createBillingTimezoneReader(env: BillingTimezoneEnv): () => Promise<string> {
  let cached: string | null = null;
  let cachedAt = 0;
  let inflight: Promise<string> | null = null;
  return async () => {
    if (cached != null && Date.now() - cachedAt < env.ttlMs) return cached;
    if (inflight == null) {
      inflight = (async () => {
        const timezone = (await readTimezoneOnce(env.db)) ?? env.fallback;
        cached = timezone;
        cachedAt = Date.now();
        return timezone;
      })().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };
}

import { and, eq, inArray } from 'drizzle-orm';
import { channels, notifyOutbox } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import type { Logger } from '@ai-gateway/core';
import type { ModelRouter } from './model-router.js';

/**
 * 渠道切换判定（候选循环共用，requirements 5.9）。
 *
 * chat-completions 与 embeddings 的「换渠道 vs 直接返回客户端」判定必须一致——
 * 历史上两路由各自维护错误码集合导致漂移（embeddings 漏掉部分错误码），
 * 单个坏渠道让 embeddings 整体不可用。集中在管线内共享，杜绝再次不一致。
 *
 * 判定口径：
 *   换渠道：5xx/网络/超时/死凭据/熔断/限流/空完成/无效响应（渠道或配置问题，别的渠道可能好）
 *   不换：400/404/413 等 4xx 客户端错误（换渠道也一样失败）
 */
const CHANNEL_SWITCHABLE_CODES = new Set([
  'upstream_error',
  'network',
  'timeout',
  'rate_limited',
  'quota_exhausted',
  'circuit_open',
  'dead_credential',
  'invalid_api_key', // 401 死凭据：此渠道 key 坏了，别的渠道可能好
  'forbidden', // 403：同上
  'empty_completion',
  'invalid_response',
  // 渠道协议/key/URL 配置错误：该渠道必然失败（从未触达上游），换渠道可能好
  'invalid_config',
]);

export function isChannelSwitchable(code: string | undefined): boolean {
  return code ? CHANNEL_SWITCHABLE_CODES.has(code) : false;
}

/**
 * 死凭据判定（应触发 DB 写回 status=4）。
 * 单一真相 = ai 包 classify 的 deadCredential 标志（401 恒真；403 命中文本特征真）——
 * 不在网关侧按错误码再判一遍（历史上两套词表不一致：classify 归一 forbidden+标志，
 * 网关只认 invalid_api_key，导致 403 死凭据渠道不落库、Redis TTL 过期后反复撞墙）。
 */
export function isDeadCredentialError(
  error: { deadCredential?: boolean; code?: string } | undefined,
): boolean {
  return error?.deadCredential === true;
}

/**
 * 死凭据 DB 持久化（requirements 5.16：死凭据隔离）。
 *
 * 当上游连续返回 invalid_api_key（401/403 + 文本特征）达阈值时，
 * ai 包的 DeadCredentialTracker 在 Redis 标记 invalid（停止路由该渠道）。
 * 本函数把该状态写回 DB channels.status=4，使：
 *   - 渠道永久退出路由（重启/Redis 清空后仍生效）
 *   - 管理端列表/告警能直接看到 status=4 的死凭据渠道
 *
 * 幂等写（多次标记同渠道 status=4 无副作用），失败仅记日志不阻塞请求。
 * status=4 后必须 bump 路由缓存版本（否则缓存渠道列表仍包含死凭据渠道）。
 */
export async function markChannelDeadCredential(
  db: Db,
  router: ModelRouter,
  channelId: number,
  logger?: Logger,
): Promise<void> {
  try {
    const updated = await db.transaction(async (tx) => {
      const rows = await tx
        .update(channels)
        .set({ status: 4, updatedAt: new Date() })
        .where(and(eq(channels.id, channelId), inArray(channels.status, [0, 3])))
        .returning({ id: channels.id });
      if (rows.length > 0) {
        // 事务性发件箱：渠道禁用事件与状态变更同事务落箱（worker 投递，不搞事后扫描）
        await tx
          .insert(notifyOutbox)
          .values({
            event: 'channel_disabled',
            payload: { channelId, reason: 'dead_credential' },
            dedupeKey: `channel-disabled:${channelId}:${Date.now()}`,
          })
          .onConflictDoNothing();
      }
      return rows;
    });
    if (updated.length > 0) {
      logger?.warn({ channelId }, 'channel marked as dead credential (status=4)');
      await router.invalidate();
    }
  } catch (err) {
    logger?.error(
      { channelId, err: (err as Error).message },
      'failed to mark channel dead credential in DB',
    );
  }
}

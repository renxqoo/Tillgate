import { eq, inArray, and } from 'drizzle-orm';
import { channels } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import type { Logger } from '@ai-gateway/logger';

/**
 * 死凭据 DB 持久化（requirements 5.16：死凭据隔离）。
 *
 * 当上游连续返回 invalid_api_key（401/403 + 文本特征）达阈值时，
 * ai 包的 DeadCredentialTracker 在 Redis 标记 invalid（停止路由该渠道）。
 * 本模块把该状态写回 DB channels.status=4，使：
 *   - 渠道永久退出路由（重启/Redis 清空后仍生效，不重新路由死凭据刷日志）
 *   - 管理端列表/告警能直接看到 status=4 的死凭据渠道
 *   - 运营换 Key（PATCH body.apiKey）时重置 status=0 恢复路由
 *
 * 设计：幂等写（多次标记同渠道 status=4 无副作用），失败仅记日志不阻塞请求。
 */

/**
 * 把渠道标记为死凭据（status=4）。
 * 仅当当前 status ∈ {0 启用, 3 熔断} 时才更新，不动人工设置的 1(禁用)/2(维护)/4(已是死凭据)。
 */
export async function markChannelDeadCredential(
  db: Db,
  channelId: number,
  logger?: Logger,
): Promise<void> {
  try {
    const updated = await db
      .update(channels)
      .set({ status: 4, updatedAt: new Date() })
      .where(and(eq(channels.id, channelId), inArray(channels.status, [0, 3])))
      .returning({ id: channels.id });
    if (updated.length > 0) {
      logger?.warn({ channelId }, 'channel marked as dead credential (status=4)');
    }
  } catch (err) {
    logger?.error({ channelId, err: (err as Error).message }, 'failed to mark channel dead credential in DB');
  }
}

/**
 * 判断错误码是否为死凭据（应触发 DB 写回 status=4）。
 * 与 chat-completions.ts 的 isChannelSwitchable 中的 invalid_api_key 对齐。
 */
export function isDeadCredentialError(code: string | undefined): boolean {
  return code === 'invalid_api_key';
}

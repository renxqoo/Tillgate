import { eq } from 'drizzle-orm';
import { modelChannels } from '@ai-gateway/db/schema';
import { bumpRouteCache, HttpError, recordAudit } from '@ai-gateway/http';
import type { AdminServices } from './index.js';

/**
 * 模型服务：渠道绑定（全量替换语义，事务保证原子性）。
 *
 * 契约：POST /api/admin/models/:id/channels，body { channels: [{channelId, weight?, priority?}] }。
 * 全量替换 = 先删旧绑定再插新的，整体包在事务里——中途失败不会留下空绑定（旧实现删插分离，无事务）。
 */

/**
 * 免费口径一致性（R6 单一真相）：is_free 与价格互斥——显式免费模型必须全零价。
 * 授权侧（billing-flow.calculateRequired）按同一规则结构性拒绝矛盾报价，此处是
 * 配置写入侧的前置防线，供路由层创建/更新与目录导入共用。
 */
export function assertFreePriceConsistency(input: {
  isFree: boolean;
  inputPrice: number;
  outputPrice: number;
  cacheInputPrice: number;
}): void {
  if (!input.isFree) return;
  if (input.inputPrice > 0 || input.outputPrice > 0 || input.cacheInputPrice > 0) {
    throw new HttpError(
      400,
      'FREE_MODEL_PRICE_CONFLICT',
      '显式免费模型必须全零价（is_free 与非零价互斥），否则授权 0 元与结算实扣口径分裂',
    );
  }
}

export interface ChannelBind {
  channelId: number;
  weight?: number;
  priority?: number;
}

export async function replaceModelChannels(
  s: AdminServices,
  mappingId: number,
  binds: ChannelBind[],
  adminId: number,
): Promise<number> {
  const rows = binds.map((item) => ({
    mappingId,
    channelId: item.channelId,
    weight: item.weight ?? 1,
    priority: item.priority ?? 0,
  }));

  const count = await s.db.transaction(async (tx) => {
    await tx.delete(modelChannels).where(eq(modelChannels.mappingId, mappingId));
    if (rows.length > 0) {
      await tx.insert(modelChannels).values(rows);
    }
    return rows.length;
  });

  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'model.bind_channels',
    targetType: 'model',
    targetId: mappingId,
    detail: { channelIds: rows.map((r) => r.channelId), count },
  });
  await bumpRouteCache(s.redis);

  return count;
}

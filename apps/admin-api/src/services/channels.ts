import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { encrypt } from '@ai-gateway/core';
import { providers, channels, modelMappings, modelChannels } from '@ai-gateway/db/schema';
import { bumpRouteCache, recordAudit } from '@ai-gateway/http';
import type { AdminServices } from './index.js';

/**
 * 渠道服务：批量导入 + 上游 Key 加密。
 *
 * 导入设计（api-contract §4.5：POST /api/admin/channels/import）：
 *   - 输入 JSON 数组，每项 { provider, name, apiKey, models?, weight?, priority? }
 *   - provider 按 name 精确匹配（不存在则报错，避免误建错配置的供应商）
 *   - 单条失败不中断整体导入（best-effort），逐条明细便于运营定位
 *   - models 命中已有 model_mappings 时自动绑定（onConflictDoNothing 去重）
 *
 * 安全：上游 Key 明文只在请求体中出现一次，落库 AES-256-GCM 密文（core encrypt）。
 */

export const importItemSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1).max(64),
  apiKey: z.string().min(1),
  models: z.array(z.string()).optional(),
  weight: z.number().int().min(1).optional(),
  priority: z.number().int().optional(),
});

export const channelImportSchema = z.object({
  channels: z.array(importItemSchema).min(1).max(1000),
});

export type ChannelImportItem = z.infer<typeof importItemSchema>;

export interface ChannelImportDetail {
  index: number;
  ok: boolean;
  channelId?: number;
  name: string;
  error?: string;
}

export interface ChannelImportResult {
  total: number;
  success: number;
  failed: number;
  details: ChannelImportDetail[];
}

export async function importChannels(
  s: AdminServices,
  items: ChannelImportItem[],
  adminId: number,
): Promise<ChannelImportResult> {
  const details: ChannelImportDetail[] = [];
  let success = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    try {
      // 1. 查供应商（按 name 精确匹配，不存在则报错）
      const provider = await s.db
        .select({ id: providers.id, name: providers.name })
        .from(providers)
        .where(eq(providers.name, item.provider))
        .limit(1);
      if (provider.length === 0) {
        details.push({ index: i, ok: false, name: item.name, error: `供应商「${item.provider}」不存在，请先创建` });
        continue;
      }

      // 2. 同名渠道查重（避免重复导入）
      const existing = await s.db
        .select({ id: channels.id })
        .from(channels)
        .where(eq(channels.name, item.name))
        .limit(1);
      if (existing.length > 0) {
        details.push({ index: i, ok: false, name: item.name, error: '同名渠道已存在' });
        continue;
      }

      // 3. 加密 key + 建渠道
      const apiKeyEnc = encrypt(item.apiKey, s.encryptionKey);
      const [created] = await s.db
        .insert(channels)
        .values({
          providerId: provider[0]!.id,
          name: item.name,
          apiKeyEnc,
          models: item.models ?? null,
          weight: item.weight ?? 1,
          priority: item.priority ?? 0,
          status: 0,
        })
        .returning({ id: channels.id });

      // 4. 若 models 提供，且存在对应 model_mappings，自动绑定（便利功能）
      if (item.models && created) {
        for (const modelName of item.models) {
          const mapping = await s.db
            .select({ id: modelMappings.id })
            .from(modelMappings)
            .where(eq(modelMappings.externalName, modelName))
            .limit(1);
          if (mapping.length > 0) {
            await s.db
              .insert(modelChannels)
              .values({ mappingId: mapping[0]!.id, channelId: created.id, weight: item.weight ?? 1, priority: item.priority ?? 0 })
              .onConflictDoNothing();
          }
        }
      }

      details.push({ index: i, ok: true, channelId: created!.id, name: item.name });
      success++;
      s.logger.info({ channelId: created!.id, name: item.name }, 'channel imported');
    } catch (err) {
      details.push({ index: i, ok: false, name: item.name, error: (err as Error).message });
    }
  }

  await recordAudit(s.db, {
    actor: 'admin',
    adminId,
    action: 'channel.import',
    targetType: 'channel',
    detail: { total: items.length, success },
  });
  // 批量失效路由缓存（一次 bump 覆盖整批导入，而非逐条）
  if (success > 0) await bumpRouteCache(s.redis);

  return { total: items.length, success, failed: items.length - success, details };
}

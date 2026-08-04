import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { providers, channels, modelMappings, modelChannels } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import { encrypt } from '../lib/crypto.js';
import { z } from 'zod';
import { recordAudit } from '../lib/audit.js';
import type { AdminEnv } from '../middleware/session.js';

/**
 * 渠道批量导入（api-contract §4.5：POST /api/admin/channels/import）。
 *
 * 输入：JSON 数组，每项 { provider, name, api_key, models?, weight?, priority? }
 *   - provider：供应商名称（已存在则复用，不存在则按默认 openai_compatible 协议 + 该名称为 base_url 占位创建）
 *     注：一期供应商 base_url 需运营预先配好；导入仅按 name 匹配，找不到则报错（避免误建错配置的供应商）
 *   - models：该渠道支持的上游模型名白名单（可选）
 *
 * 输出：逐条明细 { total, success, failed, details: [{index, ok, channelId?, error?}] }
 *
 * 设计：单条失败不中断整体导入（best-effort），每条独立处理便于运营定位问题。
 *
 * 依赖注入：encryptionKey 通过参数传入（避免直接 import 全局 env，便于测试 + 解耦）。
 */

const importItemSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1).max(64),
  apiKey: z.string().min(1),
  models: z.array(z.string()).optional(),
  weight: z.number().int().min(1).optional(),
  priority: z.number().int().optional(),
});

const importSchema = z.object({
  channels: z.array(importItemSchema).min(1).max(1000),
});

interface ImportDetail {
  index: number;
  ok: boolean;
  channelId?: number;
  name: string;
  error?: string;
}

export function channelImportRoutes(db: Db, encryptionKey: string): Hono<AdminEnv> {
  return new Hono<AdminEnv>().post('/api/admin/channels/import', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = importSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: { message: '参数校验失败', code: 'VALIDATION_ERROR', details: parsed.error.issues } }, 400);
    }
    const items = parsed.data.channels;
    const adminId = c.get('adminId');
    const details: ImportDetail[] = [];
    let success = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      try {
        // 1. 查供应商（按 name 精确匹配，不存在则报错）
        const provider = await db
          .select({ id: providers.id, name: providers.name })
          .from(providers)
          .where(eq(providers.name, item.provider))
          .limit(1);
        if (provider.length === 0) {
          details.push({ index: i, ok: false, name: item.name, error: `供应商「${item.provider}」不存在，请先创建` });
          continue;
        }

        // 2. 同名渠道查重（避免重复导入）
        const existing = await db
          .select({ id: channels.id })
          .from(channels)
          .where(eq(channels.name, item.name))
          .limit(1);
        if (existing.length > 0) {
          details.push({ index: i, ok: false, name: item.name, error: '同名渠道已存在' });
          continue;
        }

        // 3. 加密 key + 建渠道
        const apiKeyEnc = encrypt(item.apiKey, encryptionKey);
        const [created] = await db
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
            const mapping = await db
              .select({ id: modelMappings.id })
              .from(modelMappings)
              .where(eq(modelMappings.externalName, modelName))
              .limit(1);
            if (mapping.length > 0) {
              // 已绑定则跳过（复合主键去重）
              await db
                .insert(modelChannels)
                .values({ mappingId: mapping[0]!.id, channelId: created.id, weight: item.weight ?? 1, priority: item.priority ?? 0 })
                .onConflictDoNothing();
            }
          }
        }

        details.push({ index: i, ok: true, channelId: created!.id, name: item.name });
        success++;
        // 导入日志（用 console 避免循环依赖；生产环境由上层 otel/logger 接管）
        console.log('[channel-import] imported', { channelId: created!.id, name: item.name });
      } catch (err) {
        details.push({ index: i, ok: false, name: item.name, error: (err as Error).message });
      }
    }

    await recordAudit(db, {
      adminId,
      action: 'channel.import',
      targetType: 'channel',
      detail: { total: items.length, success },
    });

    return c.json({ total: items.length, success, failed: items.length - success, details }, success > 0 ? 200 : 400);
  });
}

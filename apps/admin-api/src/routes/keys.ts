import { Hono } from 'hono';
import { z } from 'zod';
import { MONEY_MAX, jsonBody, query, intParam } from '@ai-gateway/http';
import type { AdminEnv } from '@ai-gateway/identity';
import type { AdminServices } from '../services/index.js';
import { keyListQuerySchema, listApiKeys, updateApiKey } from '../services/keys.js';

/**
 * 管理员 Key 管理（限流配置视角，api-contract §4.x）。
 *
 * 与 client-api 的 keys（用户自助）区别：
 *   - 不限 userId（管理员可看所有用户的 Key）
 *   - 改限流/吊销后主动清 gateway 鉴权缓存（auth:key:{hash}）立即生效
 *
 * 安全：明文 Key 永不回显，只返回 keyPreview（脱敏，由创建时写入）。
 */

const keyUpdateSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  /** RPM 限流，null=不限流（继承用户/全局） */
  rpmLimit: z.number().int().min(1).nullable().optional(),
  /** TPM 限流，null=不限流 */
  tpmLimit: z.number().int().min(1).nullable().optional(),
  /** Key 级每日花费上限（元，>=0），null=不限。团队团员单 Key 封顶。 */
  dailySpendLimit: z.number().min(0).max(MONEY_MAX).nullable().optional(),
  status: z.number().int().min(0).max(1).optional(),
});

export function keyAdminRoutes(s: AdminServices): Hono<AdminEnv> {
  return new Hono<AdminEnv>()

    // 列表（关联用户，脱敏 preview）
    .get('/', query(keyListQuerySchema), async (c) =>
      c.json(await listApiKeys(s, c.req.valid('query'))),
    )

    // 更新限流（+ name/status），改后清 auth:key 缓存立即生效（见 service）
    .patch('/:id', jsonBody(keyUpdateSchema), async (c) => {
      await updateApiKey(s, intParam(c, 'id'), c.req.valid('json'), c.get('adminId'));
      return c.json({ ok: true });
    });
}

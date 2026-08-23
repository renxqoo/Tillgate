/**
 * Application（OAuth 客户端应用）契约：列表/创建（scope 嵌套形状）/ 路径参数。
 */
import { z } from 'zod';
import { listQuerySchema } from './shared.js';

export const appsListQuerySchema = listQuerySchema;

export const appCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().max(255).nullable().optional(),
  subscriptionId: z.number().int().positive().nullable().optional(),
  scope: z
    .object({
      models: z.array(z.string().max(64)).max(100).optional(),
      rpm: z.number().int().positive().max(1_000_000).optional(),
      tpm: z.number().int().positive().max(100_000_000).optional(),
    })
    .nullable()
    .optional(),
});

export const appIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

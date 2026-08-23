/**
 * API Key 契约：列表/创建/修补（金额与过期时间的结构性校验在此收口）。
 */
import { z } from 'zod';
import { isValidSpendLimitInput } from './shared.js';

const spendLimit = z
  .string()
  .refine(isValidSpendLimitInput, 'Must be a positive amount (value too large or invalid format)');

const futureDatetime = z
  .string()
  .datetime()
  .refine((v) => new Date(v).getTime() > Date.now(), 'Expiry time must be in the future');

export const keysListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const keyCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  remark: z.string().max(255).nullable().optional(),
  rpmLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
  tpmLimit: z.number().int().positive().max(100_000_000).nullable().optional(),
  dailySpendLimit: spendLimit.nullable().optional(),
  expiresAt: futureDatetime.nullable().optional(),
  /** 计费来源：绑定自己的订阅（或所在组织的订阅） */
  subscriptionId: z.number().int().positive().nullable().optional(),
});

export const keyPatchSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  remark: z.string().max(255).nullable().optional(),
  rpmLimit: z.number().int().positive().max(1_000_000).nullable().optional(),
  tpmLimit: z.number().int().positive().max(100_000_000).nullable().optional(),
  dailySpendLimit: spendLimit.nullable().optional(),
  expiresAt: futureDatetime.nullable().optional(),
});

export const keyIdParamSchema = z.object({ id: z.coerce.number().int().positive() });

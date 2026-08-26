/**
 * 目录域契约（v1 catalog.ts zod 面平移）。
 * 导入价格必填（提交即确认——目录价只展示不自动带入;防 0 卖亏钱）。
 */
import * as z from 'zod';
import { nonNegativeMoneyString } from './common';
import { AdminErrors } from '../error-face';

const CONTEXT_LENGTH_MAX = 2_000_000_000;

const importModelSchema = z.object({
  externalName: z.string().min(1).max(64),
  realModel: z.string().min(1).max(128),
  inputPrice: nonNegativeMoneyString,
  outputPrice: nonNegativeMoneyString,
  cacheInputPrice: nonNegativeMoneyString,
  cacheWritePrice: nonNegativeMoneyString,
  contextLength: z.coerce
    .number()
    .int()
    .positive()
    .finite()
    .max(CONTEXT_LENGTH_MAX)
    .nullable()
    .optional(),
});

const catalogImportSchema = z.object({
  sourceId: z.string().min(1).max(32),
  apiKey: z.string().min(1).optional(),
  models: z.array(importModelSchema).min(1).max(200),
});

/** 目录源路径参数词表（未知 → 404 admin.catalog_source_not_found;不泄漏源清单） */
export function catalogSourceParam(raw: string): string {
  if (!/^[a-z0-9-]{1,32}$/.test(raw)) {
    throw AdminErrors.business('catalog_source_not_found', { sourceId: raw });
  }
  return raw;
}

export const catalogContracts = {
  import: catalogImportSchema,
} as const;

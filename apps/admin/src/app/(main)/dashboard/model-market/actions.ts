'use server';

import { revalidatePath } from 'next/cache';
import { adminFetch, ApiError } from '@ai-gateway/api-client';

export interface CatalogImportModel {
  externalName: string;
  realModel: string;
  inputPrice: number;
  outputPrice: number;
  cacheInputPrice: number;
  contextLength?: number | null;
}

/** 一键入库：勾选模型 +（首次）平台 key → provider/channel/mappings */
export async function importCatalogAction(input: {
  apiKey?: string;
  models: CatalogImportModel[];
}): Promise<{ error?: string }> {
  if (input.models.length === 0) return { error: '至少选择一个模型' };
  for (const m of input.models) {
    if (!m.externalName.trim() || !m.realModel.trim()) {
      return { error: '对外名与真实模型名不能为空' };
    }
  }
  try {
    await adminFetch('/api/admin/model-catalog/import', {
      method: 'POST',
      body: {
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        models: input.models.map((m) => ({
          externalName: m.externalName.trim(),
          realModel: m.realModel.trim(),
          inputPrice: m.inputPrice,
          outputPrice: m.outputPrice,
          cacheInputPrice: m.cacheInputPrice,
          ...(m.contextLength != null ? { contextLength: m.contextLength } : {}),
        })),
      },
    });
    revalidatePath('/dashboard/model-market');
    revalidatePath('/dashboard/models');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '导入失败' };
  }
}

import type { ModelMappingSnapshot, QuoteCandidate } from './types';

/**
 * 候选链装配：主映射在前，fallbackModels
 * （对外名）逐个经目录解析后追加——一级展开，不递归（兜底的兜底无限链无界）；
 * 解析不到的兜底跳过；mappingId 去重（同一映射经两条名到达只计一次）。
 */
export async function buildCandidateChain(
  main: ModelMappingSnapshot,
  resolveFallback: (externalModel: string) => Promise<ModelMappingSnapshot | null>,
): Promise<QuoteCandidate[]> {
  const chain: QuoteCandidate[] = [toCandidate(main)];
  const seen = new Set<number>([main.mappingId]);
  // 防御脏形状（裸 SQL 写入 jsonb 字符串标量时 for...of 会按字符迭代全 miss）：
  // 非数组按无 fallback 处理——单行脏数据不熔断路由（与渠道白名单防御同哲学）
  if (!Array.isArray(main.fallbackModels)) return chain;
  for (const external of main.fallbackModels) {
    if (typeof external !== 'string') continue;
    const mapping = await resolveFallback(external);
    if (mapping == null || seen.has(mapping.mappingId)) continue;
    seen.add(mapping.mappingId);
    chain.push(toCandidate(mapping));
  }
  return chain;
}

function toCandidate(mapping: ModelMappingSnapshot): QuoteCandidate {
  return {
    mappingId: mapping.mappingId,
    externalModel: mapping.externalModel,
    realModel: mapping.realModel,
    inputPrice: mapping.inputPrice,
    cacheInputPrice: mapping.cacheInputPrice,
    cacheWritePrice: mapping.cacheWritePrice,
    outputPrice: mapping.outputPrice,
    unitPrice: mapping.unitPrice,
    pricingUnit: mapping.pricingUnit,
    unitUpperBound: mapping.unitUpperBound,
    coefficient: mapping.coefficient,
    billingPolicyFingerprint: mapping.billingPolicyFingerprint,
    ...(mapping.rpmLimit != null ? { rpmLimit: mapping.rpmLimit } : {}),
    ...(mapping.tpmLimit != null ? { tpmLimit: mapping.tpmLimit } : {}),
    ...(mapping.contextLength != null ? { contextLength: mapping.contextLength } : {}),
    ...(mapping.isFree === true ? { isFree: true } : {}),
  };
}

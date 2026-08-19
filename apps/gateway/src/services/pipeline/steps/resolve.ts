import { createHash } from 'node:crypto';
import { estimateInputTokens, generationKindDescriptor } from '@ai-gateway/ai';
import { estimateMaxCost, toDecimal } from '@ai-gateway/wallet/metering';
import { pickCoefficient } from '@ai-gateway/ledger';
import { gatewayError } from '../../../lib/errors.js';
import {
  analyzeMultimodalRequest,
  MultimodalQuoteError,
  authorizeMultimodalQuote,
} from '../../billing/multimodal-quote-policy.js';
import type { MappingCache } from '../../routing/model-router.js';
import type { AuthContext, CandidateTarget, PipelineDeps, PipelineKind } from '../types.js';
import { maxOutputTokens } from '../types.js';

/**
 * 第二步：解析（模型路由 + 费率卡系数 + 多模态分析 + 输入 token 估算 + 候选定价）。
 *
 * 输入 token 估算（单一真相：TPM 预占 + 预扣共用，见 ai/token-estimate.ts）。
 * 预扣阶段尚未选渠道，用全局权重（无 provider 覆盖/template 偏移）。
 * 口径决策（2026-08 拍板）：预扣用校准估算而非「字符数上界」——预扣不再是
 * 敞口硬上界（估算偏小 → 结算实扣可超预扣），敞口由信用模型（credit_limit）
 * 与 settle 按 calculated 实扣兜底。选择接受该平台敞口以换取更少的资金占用。
 *
 * 系数解析（2026-08 分组倍率落地）：每个候选按自己的映射解析
 * （model>group>global，ledger/coefficient.ts 单一真相）——fallback 候选与主模型
 * 可以挂不同系数。费率卡停用 → 拒绝新请求（rate_card_disabled，静态 Key 与
 * JWT 同语义）。
 */

export interface ResolveResult {
  mapping: MappingCache;
  /** 多模态分析结果（媒体计数等，用于报价） */
  multimodal: ReturnType<typeof analyzeMultimodalRequest>;
  /** 输入 token 估算（预扣/TPM 共用单一真相） */
  estInput: number;
  /** 候选定价表（主模型 + fallback，预扣按最贵候选） */
  targets: CandidateTarget[];
  /** 输出 token 上界（预扣/TPM/估算硬夹共用口径） */
  outputCap: number;
}

export async function resolveRequest(
  deps: PipelineDeps,
  kind: PipelineKind,
  body: Record<string, unknown>,
  model: string,
  auth: Pick<AuthContext, 'rateCardId'>,
): Promise<ResolveResult> {
  // ---- 模型路由：externalName → model_mappings（Redis 缓存，消除热路径每请求查 DB）----
  const mapping = await deps.router.getMapping(model);
  if (!mapping) {
    throw gatewayError('model_not_found', {
      message: `模型「${model}」不存在或已下架`,
    });
  }

  // ---- 费率卡快照：停用卡拒绝新请求（Key/JWT 同语义）----
  const coefficientSnapshot = await deps.coefficients.getSnapshot(auth.rateCardId);
  if (coefficientSnapshot && coefficientSnapshot.status !== 0) {
    throw gatewayError('rate_card_disabled', {
      message: '账户绑定的费率卡已停用，请联系管理员',
    });
  }

  let multimodal;
  try {
    multimodal = analyzeMultimodalRequest(body);
  } catch (error) {
    if (error instanceof MultimodalQuoteError) {
      throw gatewayError(error.code as Parameters<typeof gatewayError>[0], {
        message: error.message,
      });
    }
    throw error;
  }

  const estInput = estimateInputTokens(body);

  // ---- 候选定价：主模型 + fallback。预扣按最贵候选估算，杜绝 fallback 更贵导致结算透支 ----
  let targets: CandidateTarget[];
  try {
    targets = await resolveTargets(
      deps,
      kind,
      body,
      mapping,
      estInput,
      multimodal,
      coefficientSnapshot,
    );
  } catch (error) {
    if (error instanceof MultimodalQuoteError) {
      throw gatewayError(error.code as Parameters<typeof gatewayError>[0], {
        message: error.message,
        suggestion: '请调整媒体内容，或由管理员配置该模型的多模态计费策略',
      });
    }
    throw error;
  }

  return {
    mapping,
    multimodal,
    estInput,
    targets,
    outputCap: maxOutputTokens(kind, body, deps.env.GATEWAY_OUTPUT_EXPOSURE_CAP),
  };
}

/** 候选目标解析：价格预取（预扣需要），fallback 渠道列表 lazy */
async function resolveTargets(
  deps: PipelineDeps,
  kind: PipelineKind,
  body: Record<string, unknown>,
  mapping: MappingCache,
  inputTokenEstimate: number,
  multimodal: ReturnType<typeof analyzeMultimodalRequest>,
  coefficientSnapshot: Parameters<typeof pickCoefficient>[0],
): Promise<CandidateTarget[]> {
  const targets: CandidateTarget[] = [];
  const outputCap = maxOutputTokens(kind, body, deps.env.GATEWAY_OUTPUT_EXPOSURE_CAP);
  const addTarget = (m: MappingCache): void => {
    const candidateInputUpperBound = Math.max(
      inputTokenEstimate,
      authorizeMultimodalQuote(multimodal, m.billingPolicy),
    );
    // 单位计量上界：kind + 计价口径感知（video 按秒→时长上界；其余→n 倍数）
    const unitUpperBound = unitUpperBoundOf(kind, body, m.pricingUnit);
    const coefficient = pickCoefficient(coefficientSnapshot, {
      modelMappingId: m.id,
      pricingGroup: m.pricingGroup,
    });
    if (toDecimal(coefficient).lte(0)) {
      throw gatewayError('invalid_coefficient', {
        message: '模型计费配置无效（系数非正）',
      });
    }
    const estimate = estimateMaxCost({
      estimatedInputTokens: candidateInputUpperBound,
      maxOutputTokens: outputCap,
      inputPrice: m.inputPrice,
      cacheInputPrice: m.cacheInputPrice,
      outputPrice: kind === 'chat' ? m.outputPrice : 0,
      unitPrice: m.unitPrice,
      unitUpperBound,
      coefficient,
    });
    // 上游成本 = 官方价 × 上界（系数=1），与 settle.ts 的 upstream_cost 同口径
    const upstreamEstimate = estimateMaxCost({
      estimatedInputTokens: candidateInputUpperBound,
      maxOutputTokens: outputCap,
      inputPrice: m.inputPrice,
      cacheInputPrice: m.cacheInputPrice,
      outputPrice: kind === 'chat' ? m.outputPrice : 0,
      unitPrice: m.unitPrice,
      unitUpperBound,
      coefficient: '1',
    });
    targets.push({
      realModel: m.realModel,
      mappingId: m.id,
      rpmLimit: m.rpmLimit,
      tpmLimit: m.tpmLimit,
      inputPrice: m.inputPrice,
      outputPrice: m.outputPrice,
      cacheInputPrice: m.cacheInputPrice,
      pricingUnit: m.pricingUnit,
      unitPrice: m.unitPrice,
      unitUpperBound,
      coefficient,
      paramRules: m.paramRules,
      billingPolicy: m.billingPolicy,
      billingPolicyFingerprint: m.billingPolicy
        ? createHash('sha256').update(JSON.stringify(m.billingPolicy)).digest('hex')
        : null,
      isFree: m.isFree,
      inputTokenUpperBound: candidateInputUpperBound,
      estimate,
      upstreamEstimate,
      channels: null,
    });
  };

  addTarget(mapping);
  // fallback 模型（仅 chat）：预扣按最贵候选，渠道列表主模型全失败时才解析
  if (kind === 'chat') {
    for (const fb of mapping.fallbackModels ?? []) {
      const fbMapping = await deps.router.getMapping(fb);
      if (fbMapping) addTarget(fbMapping);
    }
  }
  return targets;
}

/**
 * 单位计量上界（预扣口径）：单一真相在 packages/ai generation/descriptors.ts
 * （video+second → duration 钳制 4-15 缺省 6；其余 → n 倍数，缺省 1）。
 * chat/embeddings 无描述符 → n 规则兜底（与历史行为一致）。
 */
function unitUpperBoundOf(
  kind: PipelineKind,
  body: Record<string, unknown>,
  pricingUnit: string,
): number {
  const descriptor = generationKindDescriptor(kind);
  if (descriptor) return descriptor.unitsUpperBoundOf(body, pricingUnit);
  const n = typeof body.n === 'number' && Number.isInteger(body.n) && body.n > 0 ? body.n : 1;
  return n;
}

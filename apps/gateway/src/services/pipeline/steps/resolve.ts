import { createHash } from 'node:crypto';
import { estimateInputTokens } from '@ai-gateway/ai';
import { estimateMaxCost } from '@ai-gateway/money';
import { gatewayError } from '../../../lib/errors.js';
import {
  analyzeMultimodalRequest,
  MultimodalQuoteError,
  authorizeMultimodalQuote,
} from '../../billing/multimodal-quote-policy.js';
import type { MappingCache } from '../../routing/model-router.js';
import type { CandidateTarget, PipelineDeps, PipelineKind } from '../types.js';
import { maxOutputTokens } from '../types.js';

/**
 * 第二步：解析（模型路由 + 多模态分析 + 输入 token 估算 + 候选定价）。
 *
 * 输入 token 估算（单一真相：TPM 预占 + 预扣共用，见 ai/token-estimate.ts）。
 * 预扣阶段尚未选渠道，用全局权重（无 provider 覆盖/template 偏移）。
 * 口径决策（2026-08 拍板）：预扣用校准估算而非「字符数上界」——预扣不再是
 * 敞口硬上界（估算偏小 → 结算实扣可超预扣），敞口由信用模型（credit_limit）
 * 与 settle 按 calculated 实扣兜底。选择接受该平台敞口以换取更少的资金占用。
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
  /** 费率卡系数（AuthContext.coefficient，所有金额公式共用） */
  coefficient: string,
): Promise<ResolveResult> {
  // ---- 模型路由：externalName → model_mappings（Redis 缓存，消除热路径每请求查 DB）----
  const mapping = await deps.router.getMapping(model);
  if (!mapping) {
    throw gatewayError('model_not_found', {
      message: `模型「${model}」不存在或已下架`,
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
    targets = await resolveTargets(deps, kind, body, mapping, estInput, multimodal, coefficient);
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
  coefficient: string,
): Promise<CandidateTarget[]> {
  const targets: CandidateTarget[] = [];
  const addTarget = (m: MappingCache): void => {
    const candidateInputUpperBound = Math.max(
      inputTokenEstimate,
      authorizeMultimodalQuote(multimodal, m.billingPolicy),
    );
    const outputCap = maxOutputTokens(kind, body, deps.env.GATEWAY_OUTPUT_EXPOSURE_CAP);
    const estimate = estimateMaxCost({
      estimatedInputTokens: candidateInputUpperBound,
      maxOutputTokens: outputCap,
      inputPrice: m.inputPrice,
      cacheInputPrice: m.cacheInputPrice,
      outputPrice: kind === 'chat' ? m.outputPrice : 0,
      coefficient,
    });
    // 上游成本 = 官方价 × 上界（系数=1），与 settle.ts 的 upstream_cost 同口径
    const upstreamEstimate = estimateMaxCost({
      estimatedInputTokens: candidateInputUpperBound,
      maxOutputTokens: outputCap,
      inputPrice: m.inputPrice,
      cacheInputPrice: m.cacheInputPrice,
      outputPrice: kind === 'chat' ? m.outputPrice : 0,
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

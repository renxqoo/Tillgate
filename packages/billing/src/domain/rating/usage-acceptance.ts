/**
 * 结算用量验收门（单一真相，纯函数）——上游发票只是线索，结算只消费验收后用量：
 *   B1 输出上界：outputTokens ≤ quote.maxOutputTokens（已含 n 倍数、已被上下文钳制的
 *      转发上限——上游物理上产不出更多输出 token）；
 *   B2 输入侧上界：inputTokens / cachedInputTokens / cacheWriteTokens ≤ 命中候选的
 *      inputTokenUpperBound（字节 ≥ token 的保守上界，授权时已算）；units ≤ unitUpperBound；
 *   B3 证据上界：outputTokens ≤ receipt.outputEvidenceBytes（中继/响应体 UTF-8 字节）。
 * 分级（缺陷计数只看硬违例）：
 *   硬违例（B1/B2 + B3 的输出側 cap 后超证据且超 cap 场景外的五类 kind）——界值全部
 *   由我方请求事实推导，对诚实上游是定理，超出 = 渠道谎报发票 → 记缺陷（计数 + 审计
 *   + 过阈熔断）；
 *   软钳制（B3 证据界 evidence_bound）——依赖「我方字节统计与供应商 token 口径一致」
 *   这一前提。供应商把隐藏 token（如 reasoning）计入 output_tokens 而响应体不含其
 *   字节时，该界不是定理（系统性误判 → 诚实渠道被误杀熔断），故只钳计费不记缺陷。
 *   真谎报输出侧发票仍被硬界 B1 捕获——保护不降级。
 *   ⚠ 已知盲区（issue #83）：quote.maxOutputTokens 缺失或为 0（embeddings/modality
 *   端点、存量缺界数据）时 B1 解析为 null 跳过，输出侧唯一剩余界是本软界——
 *   此类渠道的输出侧谎报不计缺陷不熔断，只被钳到证据字节（大响应体下界宽）。
 * 结算照常按钳后值完成（两级钳制都生效于计费）。
 *
 * 估算收据（estimated）不经本门：数值派生自我方特征/字节，有界性由构造保证。
 * 旧收据/旧 quote 缺某界 → 该界跳过（无版本双轨，缺省即放行该界）。
 */
import type { UsageReceipt } from './types.js';

/** 钳制事实（审计与缺陷计数的载荷；original > clamped 才出现） */
export interface UsageClamp {
  readonly kind:
    | 'output_cap'
    | 'input_bound'
    | 'cached_bound'
    | 'cache_write_bound'
    | 'unit_bound'
    | 'evidence_bound'
    | 'evidence_bound_hard';
  readonly field:
    | 'outputTokens'
    | 'inputTokens'
    | 'cachedInputTokens'
    | 'cacheWriteTokens'
    | 'units';
  readonly original: number;
  readonly clamped: number;
  /** 该次钳制依据的界值（审计定位用） */
  readonly bound: number;
}

/**
 * 钳制分级（缺陷计数单一真相）：硬违例 = 界值由我方请求事实推导、对诚实上游
 * 是定理，超出即谎报证据 → 记缺陷；软钳制 = 界依赖供应商口径假设（隐藏 token
 * 口径下非定理）→ 只钳计费不记缺陷。新 kind 必须显式归级（穷举封闭，
 * 漏归级编译期即拒——防止未来新增界被默认当成硬违例误杀渠道）。
 *
 * evidence_bound_hard（issue #83）：B1（maxOutputTokens）缺失且输出侧计费时，
 * 证据字节是仅剩的物理事实界——超界即谎报证据成立，升级为硬违例
 *（B1 存在或输出免费时维持软钳——issue #80 语义不变）。
 */
export function isHardViolation(clamp: UsageClamp): boolean {
  switch (clamp.kind) {
    case 'output_cap':
    case 'input_bound':
    case 'cached_bound':
    case 'cache_write_bound':
    case 'unit_bound':
    case 'evidence_bound_hard':
      return true;
    case 'evidence_bound':
      return false;
  }
}

export interface UsageAcceptanceResult {
  /** 验收后收据（usage 已钳制；无违规则原引用返回——零拷贝快路径） */
  readonly receipt: UsageReceipt;
  readonly clamps: readonly UsageClamp[];
}

interface Bound {
  outputCap: number | null;
  inputUpper: number | null;
  unitUpper: number | null;
}

/** 持久化 quote 行（jsonb 读出为宽形状；候选缺位/形状异常 = 旧数据，界为 null 跳过） */
type QuoteLike = { maxOutputTokens?: unknown; candidates?: unknown } | null | undefined;

/** 正有限数收窄（非数/非正/非有限 → null） */
const numeric = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;

/** 输出侧计费判定（issue #83）：候选 outputPrice 为正有限数 = 有资金敞口 */
const outputPricedOf = (candidate: unknown): boolean => {
  const c = candidate as { outputPrice?: unknown } | undefined;
  return (
    numeric(
      typeof c?.outputPrice === 'string' ? Number(c.outputPrice) : (c?.outputPrice as number),
    ) != null
  );
};

/** 从持久化 quote 取命中候选（缺位/形状异常 = 旧数据，返回 undefined） */
function candidateOf(
  quote: QuoteLike,
  mappingId: number,
):
  | {
      inputTokenUpperBound?: unknown;
      unitUpperBound?: unknown;
      outputPrice?: unknown;
    }
  | undefined {
  if (quote == null || !Array.isArray(quote.candidates)) return undefined;
  const candidate = quote.candidates.find(
    (c) =>
      typeof c === 'object' && c !== null && (c as { mappingId?: unknown }).mappingId === mappingId,
  );
  return candidate as
    | { inputTokenUpperBound?: unknown; unitUpperBound?: unknown; outputPrice?: unknown }
    | undefined;
}

/** 从持久化 quote 解出命中候选的三界 */
function boundsOf(quote: QuoteLike, mappingId: number): Bound {
  const c = candidateOf(quote, mappingId);
  return {
    outputCap: numeric(quote?.maxOutputTokens),
    inputUpper: numeric(c?.inputTokenUpperBound),
    unitUpper: numeric(c?.unitUpperBound),
  };
}

function clampTo(value: number, bound: number | null): { value: number; clamped: boolean } {
  if (bound == null || value <= bound) return { value, clamped: false };
  return { value: bound, clamped: true };
}

/** 输出侧钳制：先准入 cap，再证据字节（更紧者生效——两级各记一条钳制事实）。
 * B1 缺失且输出计费时证据界升级硬（issue #83——唯一剩余物理界）*/
function clampOutput(args: {
  outputTokens: number;
  bounds: Bound;
  evidence: number | null;
  outputPriced: boolean;
  clamps: UsageClamp[];
}): number {
  const { outputTokens, bounds, evidence, outputPriced, clamps } = args;
  const cap = clampTo(outputTokens, bounds.outputCap);
  if (cap.clamped) {
    clamps.push({
      kind: 'output_cap',
      field: 'outputTokens',
      original: outputTokens,
      clamped: cap.value,
      bound: bounds.outputCap ?? 0,
    });
  }
  const byEvidence = clampTo(cap.value, evidence);
  if (byEvidence.clamped) {
    clamps.push({
      kind: bounds.outputCap == null && outputPriced ? 'evidence_bound_hard' : 'evidence_bound',
      field: 'outputTokens',
      original: cap.value,
      clamped: byEvidence.value,
      bound: evidence ?? 0,
    });
  }
  return byEvidence.value;
}

/** 可选侧字段钳制（0 值跳过——未上报字段不产生事实；kind 由字段名派生） */
function clampOptionalField(args: {
  usage: { cacheWriteTokens?: number; units?: number };
  field: 'cacheWriteTokens' | 'units';
  bound: number | null;
  clamps: UsageClamp[];
}): void {
  const { usage, field, bound, clamps } = args;
  const original = usage[field] ?? 0;
  const b = clampTo(original, bound);
  if (original > 0 && b.clamped) {
    usage[field] = b.value;
    clamps.push({
      kind: field === 'cacheWriteTokens' ? 'cache_write_bound' : 'unit_bound',
      field,
      original,
      clamped: b.value,
      bound: bound ?? 0,
    });
  }
}

/** 输入侧钳制（就地写回副本）：input → cached（子集）→ cacheWrite（派生）→ units */
function clampInputSide(
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens?: number;
    units?: number;
  },
  bounds: Bound,
  clamps: UsageClamp[],
): void {
  const inputB = clampTo(usage.inputTokens, bounds.inputUpper);
  if (inputB.clamped) {
    clamps.push({
      kind: 'input_bound',
      field: 'inputTokens',
      original: usage.inputTokens,
      clamped: inputB.value,
      bound: bounds.inputUpper ?? 0,
    });
  }
  usage.inputTokens = inputB.value;
  const cachedB = clampTo(usage.cachedInputTokens, inputB.value);
  if (cachedB.clamped) {
    clamps.push({
      kind: 'cached_bound',
      field: 'cachedInputTokens',
      original: usage.cachedInputTokens,
      clamped: cachedB.value,
      bound: inputB.value,
    });
  }
  usage.cachedInputTokens = cachedB.value;
  clampOptionalField({ usage, field: 'cacheWriteTokens', bound: bounds.inputUpper, clamps });
  clampOptionalField({ usage, field: 'units', bound: bounds.unitUpper, clamps });
}

export function acceptTrustedUsage(input: {
  receipt: UsageReceipt;
  quote: QuoteLike;
}): UsageAcceptanceResult {
  const { receipt } = input;
  if (receipt.usage.estimated) return { receipt, clamps: [] };

  const bounds = boundsOf(input.quote, receipt.mappingId);
  const candidate = candidateOf(input.quote, receipt.mappingId);
  const evidence = numeric(receipt.outputEvidenceBytes);
  const clamps: UsageClamp[] = [];
  const usage = { ...receipt.usage };
  usage.outputTokens = clampOutput({
    outputTokens: usage.outputTokens,
    bounds,
    evidence,
    outputPriced: outputPricedOf(candidate),
    clamps,
  });
  clampInputSide(usage, bounds, clamps);

  if (clamps.length === 0) return { receipt, clamps: [] };
  return { receipt: { ...receipt, usage: usage as UsageReceipt['usage'] }, clamps };
}

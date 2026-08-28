/**
 * 结算用量验收门（单一真相，纯函数）——上游发票只是线索，结算只消费验收后用量：
 *   B1 输出上界：outputTokens ≤ quote.maxOutputTokens（已含 n 倍数、已被上下文钳制的
 *      转发上限——上游物理上产不出更多输出 token）；
 *   B2 输入侧上界：inputTokens / cachedInputTokens / cacheWriteTokens ≤ 命中候选的
 *      inputTokenUpperBound（字节 ≥ token 的保守上界，授权时已算）；units ≤ unitUpperBound；
 *   B3 证据上界：outputTokens ≤ receipt.outputEvidenceBytes（中继/响应体 UTF-8 字节；
 *      每 token 至少 1 字节为定理，帧/JSON 结构开销只放大上界——安全方向）。
 * 三界对诚实上游全部是定理而非启发式：零误伤可证明。任一钳制发生 = 渠道谎报发票
 * → 调用方记渠道缺陷（计数 + 审计 + 过阈熔断），结算照常按钳后值完成。
 *
 * 估算收据（estimated）不经本门：数值派生自我方特征/字节，有界性由构造保证。
 * 旧收据/旧 quote 缺某界 → 该界跳过（无版本双轨，缺省即放行该界）。
 */
import type { UsageReceipt } from './types.js';

/** 钳制事实（审计与缺陷计数的载荷；original > clamped 才出现） */
export interface UsageClamp {
  readonly kind: 'output_cap' | 'input_bound' | 'cached_bound' | 'cache_write_bound' | 'unit_bound' | 'evidence_bound';
  readonly field: 'outputTokens' | 'inputTokens' | 'cachedInputTokens' | 'cacheWriteTokens' | 'units';
  readonly original: number;
  readonly clamped: number;
  /** 该次钳制依据的界值（审计定位用） */
  readonly bound: number;
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

/** 从持久化 quote 解出命中候选的三界 */
function boundsOf(quote: QuoteLike, mappingId: number): Bound {
  if (quote == null || !Array.isArray(quote.candidates)) {
    return { outputCap: null, inputUpper: null, unitUpper: null };
  }
  const candidate = quote.candidates.find(
    (c) => typeof c === 'object' && c !== null && (c as { mappingId?: unknown }).mappingId === mappingId,
  );
  const c = candidate as { inputTokenUpperBound?: unknown; unitUpperBound?: unknown } | undefined;
  return {
    outputCap: numeric(quote.maxOutputTokens),
    inputUpper: numeric(c?.inputTokenUpperBound),
    unitUpper: numeric(c?.unitUpperBound),
  };
}

function clampTo(value: number, bound: number | null): { value: number; clamped: boolean } {
  if (bound == null || value <= bound) return { value, clamped: false };
  return { value: bound, clamped: true };
}

/** 输出侧钳制：先准入 cap，再证据字节（更紧者生效——两级各记一条钳制事实） */
function clampOutput(
  args: { outputTokens: number; bounds: Bound; evidence: number | null; clamps: UsageClamp[] },
): number {
  const { outputTokens, bounds, evidence, clamps } = args;
  const cap = clampTo(outputTokens, bounds.outputCap);
  if (cap.clamped) {
    clamps.push({ kind: 'output_cap', field: 'outputTokens', original: outputTokens, clamped: cap.value, bound: bounds.outputCap ?? 0 });
  }
  const byEvidence = clampTo(cap.value, evidence);
  if (byEvidence.clamped) {
    clamps.push({ kind: 'evidence_bound', field: 'outputTokens', original: cap.value, clamped: byEvidence.value, bound: evidence ?? 0 });
  }
  return byEvidence.value;
}

/** 输入侧钳制（就地写回副本）：input → cached（子集）→ cacheWrite（派生）→ units */
function clampInputSide(
  usage: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens?: number; units?: number },
  bounds: Bound,
  clamps: UsageClamp[],
): void {
  const inputB = clampTo(usage.inputTokens, bounds.inputUpper);
  if (inputB.clamped) {
    clamps.push({ kind: 'input_bound', field: 'inputTokens', original: usage.inputTokens, clamped: inputB.value, bound: bounds.inputUpper ?? 0 });
  }
  usage.inputTokens = inputB.value;
  const cachedB = clampTo(usage.cachedInputTokens, inputB.value);
  if (cachedB.clamped) {
    clamps.push({ kind: 'cached_bound', field: 'cachedInputTokens', original: usage.cachedInputTokens, clamped: cachedB.value, bound: inputB.value });
  }
  usage.cachedInputTokens = cachedB.value;
  const writeOriginal = usage.cacheWriteTokens ?? 0;
  const writeB = clampTo(writeOriginal, bounds.inputUpper);
  if (writeOriginal > 0 && writeB.clamped) {
    usage.cacheWriteTokens = writeB.value;
    clamps.push({ kind: 'cache_write_bound', field: 'cacheWriteTokens', original: writeOriginal, clamped: writeB.value, bound: bounds.inputUpper ?? 0 });
  }
  const unitsOriginal = usage.units ?? 0;
  const unitsB = clampTo(unitsOriginal, bounds.unitUpper);
  if (unitsOriginal > 0 && unitsB.clamped) {
    usage.units = unitsB.value;
    clamps.push({ kind: 'unit_bound', field: 'units', original: unitsOriginal, clamped: unitsB.value, bound: bounds.unitUpper ?? 0 });
  }
}

export function acceptTrustedUsage(input: {
  receipt: UsageReceipt;
  quote: QuoteLike;
}): UsageAcceptanceResult {
  const { receipt } = input;
  if (receipt.usage.estimated) return { receipt, clamps: [] };

  const bounds = boundsOf(input.quote, receipt.mappingId);
  const evidence = numeric(receipt.outputEvidenceBytes);
  const clamps: UsageClamp[] = [];
  const usage = { ...receipt.usage };
  usage.outputTokens = clampOutput({ outputTokens: usage.outputTokens, bounds, evidence, clamps });
  clampInputSide(usage, bounds, clamps);

  if (clamps.length === 0) return { receipt, clamps: [] };
  return { receipt: { ...receipt, usage: usage as UsageReceipt['usage'] }, clamps };
}

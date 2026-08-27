import { asRecord } from '../internal/util';
import type { Usage } from '../types';

/**
 * usage 归一化：
 *   - OpenAI 风格: prompt_tokens_details.cached_tokens → cachedInputTokens
 *   - DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens
 *   - Mistral: prompt_tokens_details.cached_tokens 及其 camel 变体（promptTokensDetails.
 *     cachedTokens / promptTokenDetails.cachedTokens / numCachedTokens——参考 pi-ai mistral 方言）
 *   - 无缓存字段 → cachedInputTokens = 0
 *   - usage 缺失/冲突 → 返回 null，由调用方按字符估算（estimated=true，见 token-estimate.ts）
 */

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v)) {
    const parsed = Number(v);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function compatible(a: number | undefined, b: number | undefined): number | undefined | null {
  if (a !== undefined && b !== undefined && a !== b) return null;
  return a ?? b;
}

/** Mistral 原生 API 的 camel 变体（与 snake 变体同值时才采信——一致性校验同 OpenAI 风格）。
 *  compatible 的 null 是冲突信号不是值，嵌套组合必须逐层显式判 null（?? 会吞掉冲突）。 */
function mistralCamelCached(u: Record<string, unknown>): number | null {
  const camelDetails = compatible(
    num(asRecord(u.promptTokensDetails)?.cachedTokens),
    num(asRecord(u.promptTokenDetails)?.cachedTokens),
  );
  const camelNums = compatible(num(u.numCachedTokens), num(u.num_cached_tokens));
  if (camelDetails === null || camelNums === null) return null;
  const mistralCamel = compatible(camelDetails, camelNums);
  if (mistralCamel === null) return null;
  return mistralCamel ?? 0;
}

/** 缓存读分量解析：DeepSeek hit/miss 优先，次 OpenAI snake 细节，再次 Mistral camel；冲突 → null */
function resolveCachedTokens(u: Record<string, unknown>): number | null {
  const hit = num(u.prompt_cache_hit_tokens);
  const miss = num(u.prompt_cache_miss_tokens);
  if (hit !== undefined || miss !== undefined) return hit ?? 0;
  const promptDetails = asRecord(u.prompt_tokens_details);
  const inputDetails = asRecord(u.input_tokens_details);
  const detailCached = compatible(
    promptDetails ? num(promptDetails.cached_tokens) : undefined,
    inputDetails ? num(inputDetails.cached_tokens) : undefined,
  );
  if (detailCached === null) return null;
  if (detailCached !== undefined) return detailCached;
  return mistralCamelCached(u);
}

/** 终态校验：total 一致性 + 双侧非零。total 含额外分量（cache-write/reasoning）
 *  时弃真退估算（返回 null）——弃真可观测由调用方日志承担（纯函数零副作用）。 */
function usageTotalValid(
  u: Record<string, unknown>,
  inputTokens: number,
  outputTokens: number,
): boolean {
  const total = num(u.total_tokens);
  if (total !== undefined && total !== inputTokens + outputTokens) return false;
  return inputTokens !== 0 || outputTokens !== 0;
}

/** 缓存写入方言字段（OpenAI 风格顶层 cache_write_tokens——pi-ai 同名字段；
 *  Anthropic 经 claude 翻译层以同名字段携带进规范形 usage） */
function cacheWriteField(u: Record<string, unknown>): { cacheWriteTokens?: number } {
  const cacheWrite = num(u.cache_write_tokens);
  return cacheWrite !== undefined && cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {};
}

/** 输入侧定值：主值与 DeepSeek 重建值合流 + 安全整数与缓存不超上限校验；不可信 → null */
function finalInputTokens(
  input: number | undefined,
  reconstructedInput: number | undefined,
  cached: number,
): number | null {
  if (!Number.isSafeInteger(reconstructedInput ?? 0)) return null;
  const inputTokens = compatible(input, reconstructedInput);
  if (inputTokens === null || inputTokens === undefined || cached > inputTokens) return null;
  return inputTokens;
}

export function normalizeUsage(usageRaw: unknown): Usage | null {
  const u = asRecord(usageRaw);
  if (!u) return null;

  const input = compatible(num(u.prompt_tokens), num(u.input_tokens));
  const output = compatible(num(u.completion_tokens), num(u.output_tokens));
  if (input === null || output === null) return null;

  const cached = resolveCachedTokens(u);
  if (cached === null) return null;
  const hit = num(u.prompt_cache_hit_tokens);
  const miss = num(u.prompt_cache_miss_tokens);
  const reconstructedInput =
    hit !== undefined || miss !== undefined ? (hit ?? 0) + (miss ?? 0) : undefined;
  const inputTokens = finalInputTokens(input, reconstructedInput, cached);
  if (inputTokens === null) return null;
  const outputTokens = output ?? 0;
  if (!usageTotalValid(u, inputTokens, outputTokens)) return null;
  return {
    inputTokens,
    cachedInputTokens: cached,
    outputTokens,
    estimated: false,
    ...cacheWriteField(u),
    raw: usageRaw,
  };
}

export type { Usage } from '../types';

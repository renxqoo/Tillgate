import { asRecord } from '../internal/util';
import type { Usage } from '../types';


/**
 * 弃真观测钩子（B3 修复：v1 静默丢弃 usage 零观测——total 不一致/0+0 场景
 * 真实 usage 被丢退估算是计费级隐患）。pipeline 装配时注入 logger；默认空。
 */
export const usageDiscardHooks: Array<(reason: string, raw: unknown) => void> = [];

function reportDiscard(reason: string, raw: unknown): void {
  for (const h of usageDiscardHooks.slice()) {
    try {
      h(reason, raw);
    } catch {
      /* 观察者异常不破坏归一 */
    }
  }
}

/**
 * usage 归一化（ai-package.md §7.5）：
 *   - OpenAI 风格: prompt_tokens_details.cached_tokens → cachedInputTokens
 *   - DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens
 *   - Mistral: prompt_tokens_details.cached_tokens 及其 camel 变体（promptTokensDetails.
 *     cachedTokens / promptTokenDetails.cachedTokens / numCachedTokens——参考 pi-ai mistral 方言）
 *   - 无缓存字段 → cachedInputTokens = 0
 *   - usage 缺失 → 返回 null，由调用方按字符估算（estimated=true，见 token-estimate.ts）
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

export function normalizeUsage(usageRaw: unknown): Usage | null {
  const u = asRecord(usageRaw);
  if (!u) return null;

  const input = compatible(num(u.prompt_tokens), num(u.input_tokens));
  const output = compatible(num(u.completion_tokens), num(u.output_tokens));
  if (input === null || output === null) return null;

  // DeepSeek 风格优先（同时存在时以 cache_hit/cache_miss 为准）
  const hit = num(u.prompt_cache_hit_tokens);
  const miss = num(u.prompt_cache_miss_tokens);
  let cached = 0;
  if (hit !== undefined || miss !== undefined) {
    cached = hit ?? 0;
  } else {
    const promptDetails = asRecord(u.prompt_tokens_details);
    const inputDetails = asRecord(u.input_tokens_details);
    const detailCached = compatible(
      promptDetails ? num(promptDetails.cached_tokens) : undefined,
      inputDetails ? num(inputDetails.cached_tokens) : undefined,
    );
    if (detailCached === null) return null;
    if (detailCached !== undefined) {
      cached = detailCached;
    } else {
      // Mistral 原生 API 的 camel 变体（与 snake 变体同值时才采信——一致性校验同 OpenAI 风格）。
      // compatible 的 null 是冲突信号不是值，嵌套组合必须逐层显式判 null（?? 会吞掉冲突）。
      const camelDetails = compatible(
        num(asRecord(u.promptTokensDetails)?.cachedTokens),
        num(asRecord(u.promptTokenDetails)?.cachedTokens),
      );
      const camelNums = compatible(num(u.numCachedTokens), num(u.num_cached_tokens));
      if (camelDetails === null || camelNums === null) return null;
      const mistralCamel = compatible(camelDetails, camelNums);
      if (mistralCamel === null) return null;
      cached = mistralCamel ?? 0;
    }
  }

  const reconstructedInput =
    hit !== undefined || miss !== undefined ? (hit ?? 0) + (miss ?? 0) : undefined;
  if (!Number.isSafeInteger(reconstructedInput ?? 0)) return null;
  const inputTokens = compatible(input, reconstructedInput);
  if (inputTokens === null || inputTokens === undefined || cached > inputTokens) return null;
  const outputTokens = output ?? 0;
  const total = num(u.total_tokens);
  if (total !== undefined && total !== inputTokens + outputTokens) {
    // B3：total 含额外分量（cache-write/reasoning）时真实 usage 被弃——必须可观测
    reportDiscard('total_mismatch', u);
    return null;
  }
  if (inputTokens === 0 && outputTokens === 0) {
    reportDiscard('zero_usage', u);
    return null;
  }
  // 缓存写入方言（OpenAI 风格顶层 cache_write_tokens——pi-ai 同名字段；
  // Anthropic 经 claude 翻译层以同名字段携带进规范形 usage）
  const cacheWrite = num(u.cache_write_tokens);
  return {
    inputTokens,
    cachedInputTokens: cached,
    outputTokens,
    estimated: false,
    ...(cacheWrite !== undefined && cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    raw: usageRaw,
  };
}

export type { Usage } from '../types';

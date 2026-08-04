import type { Usage } from '../types.js';

/**
 * usage 归一化（ai-package.md §7.5）：
 *   - OpenAI 风格: prompt_tokens_details.cached_tokens → cachedInputTokens
 *   - DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens
 *   - 无缓存字段 → cachedInputTokens = 0
 *   - usage 缺失 → 返回 null，由调用方按字符估算（estimated=true，全部按未缓存计）
 */

export interface NormalizeOptions {
  charPerToken: number;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

export function normalizeUsage(usageRaw: unknown): Usage | null {
  const u = asRecord(usageRaw);
  if (!u) return null;

  const promptTokens = num(u.prompt_tokens);
  const completionTokens = num(u.completion_tokens);
  if (promptTokens === undefined && completionTokens === undefined) return null;

  // DeepSeek 风格优先（同时存在时以 cache_hit/cache_miss 为准）
  const hit = num(u.prompt_cache_hit_tokens);
  const miss = num(u.prompt_cache_miss_tokens);
  let cached = 0;
  if (hit !== undefined || miss !== undefined) {
    cached = hit ?? 0;
  } else {
    const details = asRecord(u.prompt_tokens_details);
    cached = details ? (num(details.cached_tokens) ?? 0) : 0;
  }

  const inputTokens = promptTokens ?? (hit ?? 0) + (miss ?? 0);
  return {
    inputTokens,
    cachedInputTokens: cached,
    outputTokens: completionTokens ?? 0,
    estimated: false,
    raw: usageRaw,
  };
}

/** 按字符数估算 tokens（usage 缺失时兜底；全部按未缓存输入计） */
export function estimateTokens(charCount: number, charPerToken: number): number {
  return Math.max(1, Math.ceil(charCount / charPerToken));
}

export type { Usage } from '../types.js';

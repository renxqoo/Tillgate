import type { Usage } from '../types';

/**
 * OpenAI 规范形 usage 提取（共享件）。
 * 双形兜底模式：原生形（协议私有）由各 adapter 先试，本件兜翻译后的 OpenAI 形。
 */
export function extractOpenAiUsage(res: unknown): Usage | null {
  const j = res as Record<string, unknown> | null;
  const usage = j?.usage as Record<string, unknown> | undefined;
  if (
    !usage ||
    typeof usage.prompt_tokens !== 'number' ||
    typeof usage.completion_tokens !== 'number'
  ) {
    return null;
  }
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const cacheWrite = usage.cache_write_tokens;
  return {
    inputTokens: usage.prompt_tokens,
    cachedInputTokens: typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0,
    ...(typeof cacheWrite === 'number' && cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    outputTokens: usage.completion_tokens,
    estimated: false,
    raw: usage,
  };
}

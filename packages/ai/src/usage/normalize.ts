import { asArray, asRecord } from '../internal/util.js';
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

  // 加括号消除歧义：?? 优先级低于 +，原写法正确但易误读
  const inputTokens = promptTokens ?? ((hit ?? 0) + (miss ?? 0));
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

// ---- usage 缺失时的字符估算兜底（estimated=true） ----

/**
 * 请求文本总长度（usage 缺失时估算输入 tokens）。
 * 口径保守（偏多计）：messages.content + tools 定义体（企业 Agent 工具调用主要 token 消耗源）。
 * 仅 usage 缺失时兜底，非精确计量——精确值以供应商 usage 为准。
 */
export function extractRequestChars(body: unknown): number {
  const rec = asRecord(body);
  if (!rec) return 0;
  let n = 0;
  const messages = asArray(rec.messages);
  if (messages) {
    for (const m of messages) {
      const content = asRecord(m)?.content;
      if (typeof content === 'string') {
        n += content.length;
      } else if (Array.isArray(content)) {
        for (const part of content) {
          const p = asRecord(part);
          if (p && typeof p.text === 'string') n += p.text.length;
        }
      }
    }
  }
  // tools 数组：企业 Agent 工具调用的主要输入 token 消耗源，纳入估算避免显著少计
  const tools = asArray(rec.tools);
  if (tools && tools.length > 0) {
    try {
      n += JSON.stringify(tools).length;
    } catch {
      /* 循环引用等异常 → 跳过，不破坏估算 */
    }
  }
  return n;
}

/**
 * 响应 choices 文本总长度（usage 缺失时估算输出 tokens）。
 * 纳入 content + tool_calls.arguments（工具调用响应的主要输出 token 源），
 * 避免纯工具调用响应（content=null）估算为 0 → outputTokens 严重少计。
 */
export function extractResponseChars(json: unknown): number {
  const first = asRecord(asArray(asRecord(json)?.choices)?.[0]);
  if (!first) return 0;
  let n = 0;
  const message = asRecord(first.message);
  if (message) {
    if (typeof message.content === 'string') n += message.content.length;
    // tool_calls：函数调用的 arguments（JSON 字符串）是输出 token 的主要消耗源
    const toolCalls = asArray(message.tool_calls);
    if (toolCalls) {
      for (const tc of toolCalls) {
        const fn = asRecord(asRecord(tc)?.function);
        if (fn && typeof fn.arguments === 'string') n += fn.arguments.length;
      }
    }
  }
  if (typeof first.text === 'string') n += first.text.length; // 补全类响应
  return n;
}

/** usage 缺失兜底：请求/响应按字符估算，全部按未缓存计 */
export function estimateUsage(reqBody: unknown, resJson: unknown, charPerToken: number): Usage {
  return {
    inputTokens: estimateTokens(extractRequestChars(reqBody), charPerToken),
    cachedInputTokens: 0,
    outputTokens: estimateTokens(extractResponseChars(resJson), charPerToken),
    estimated: true,
    raw: null,
  };
}

export type { Usage } from '../types.js';

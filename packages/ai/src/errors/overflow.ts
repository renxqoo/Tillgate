/**
 * 上下文溢出错误模式库（各供应商「输入超长」报错的文本特征）。
 *
 * 模式清单移植自 @earendil-works/pi-ai utils/overflow.ts（MIT，实测踩坑沉淀），
 * 按本仓词表裁剪并保留 attribution。溢出错误的正确语义：
 *   - 不可重试（同样的输入再发还是溢出，重试只烧钱）
 *   - 不计熔断（请求侧问题，不是渠道故障）
 *   - 不换渠道（同模型上下文窗口一致；换渠救不了参数错误）
 *   - 4xx 原码透传给客户端（用户应缩短输入或换长窗模型）
 *
 * 排除表：会误命中通用模式的非溢出错误（Bedrock 的 Throttling error 前缀、
 * 通用限流文案）——先排再匹配，误分类会把限流错当溢出吞掉重试。
 */

import { contextWindowOf } from '../usage/model-meta';

/** 溢出模式（供应商注释 = 实测报错样例来源） */
export const OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt is too long/i, // Anthropic token 溢出
  /request_too_large/i, // Anthropic 请求体超限（HTTP 413）
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI（completions 与 responses 两个面）
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI 兼容代理（LiteLLM 等）
  /input token count.*exceeds the maximum/i, // Google（Gemini）
  /maximum prompt length is \d+/i, // xAI（Grok）
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter（多数后端）
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi
  /too large for model with \d+ maximum context length/i, // Mistral
  /model_context_window_exceeded/i, // z.ai（非标 finish_reason 以错误文本出现）
  /prompt too long; exceeded (?:max )?context length/i, // Ollama 显式溢出
  /context[_ ]length[_ ]exceeded/i, // 通用兜底
  /too many tokens/i, // 通用兜底
  /token limit exceeded/i, // 通用兜底
  /^4(?:00|13)\s*(?:status code)?\s*\(no body\)$/i, // Cerebras：400/413 且无 body
];

/** 非溢出排除表（命中即不判溢出——限流/服务不可用文案与通用模式撞形） */
export const NON_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /^(Throttling error|Service unavailable):/i, // Bedrock 人读前缀（非溢出）
  /rate limit/i, // 通用限流
  /too many requests/i, // 通用 429
];

/** 错误文本是否为上下文溢出（先排非溢出，再匹配溢出模式） */
export function isContextOverflowMessage(message: string): boolean {
  if (NON_OVERFLOW_PATTERNS.some((p) => p.test(message))) return false;
  return OVERFLOW_PATTERNS.some((p) => p.test(message));
}

/**
 * 静默溢出判定（pi-ai overflow.ts 策略二）：部分供应商对超窗输入不报错、
 * 静默截断后正常返回——唯一线索是 usage.inputTokens 超过模型上下文窗口
 * （窗口数据：usage/model-meta.generated.ts，models.dev 快照）。
 *
 * 语义定位 = 可观测信号（日志 + success 事件 contextOverflow 旗标），
 * 不翻转成功/失败：已按供应商 usage 计费是正确口径，且窗口元数据可能滞后——
 * 误杀好响应的代价高于漏报。
 */
export function detectSilentOverflow(
  inputTokens: number,
  providerName?: string,
  model?: string,
): boolean {
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) return false;
  const window = contextWindowOf(providerName, model);
  if (window === null) return false;
  return inputTokens > window;
}

/**
 * BPE 真分词器（js-tiktoken，纯 JS 无 WASM）——估算器主路径的编码器层。
 *
 * 分层（token-estimate 单一真相）：
 *   1. tiktoken（模型族解析编码器；pi-ai 同款策略：默认 cl100k_base，
 *      现代 OpenAI 系用 o200k_base）
 *   2. 特征向量启发式兜底（编码器不可用 / 超长文本降级 / 编码异常）
 *
 * 超长降级：> TOKENIZE_MAX_CHARS 的文本走启发式——分词是纯 CPU，
 * 超大输入（对抗或异常）不值得精确计数，热路径须有界。
 * 编码器懒加载单例（cl100k 词表 ~2MB 内存，首次调用 ~50ms）。
 */
import { getEncoding } from 'js-tiktoken';

/** 超过该字符数的文本降级启发式（热路径 CPU 有界） */
export const TOKENIZE_MAX_CHARS = 200_000;

/** 模型名 → 编码器族（o200k 覆盖现代 OpenAI；其余全部 cl100k 近似——pi-ai 同策略） */
function encodingNameOf(model: string): 'o200k_base' | 'cl100k_base' {
  if (/^(gpt-4o|gpt-4\.1|gpt-5|o[134](-|$)|chatgpt-4o)/i.test(model)) return 'o200k_base';
  return 'cl100k_base';
}

const encoders = new Map<string, ReturnType<typeof getEncoding>>();

function encoderOf(name: 'o200k_base' | 'cl100k_base') {
  let enc = encoders.get(name);
  if (enc === undefined) {
    enc = getEncoding(name);
    encoders.set(name, enc);
  }
  return enc;
}

/**
 * 文本 → 精确 token 数（按模型族编码器）。
 * 返回 null = 不可用（无模型名 / 超长降级 / 编码异常）——调用方回落启发式。
 */
export function tokenCountOf(text: string, model?: string): number | null {
  if (!model || !text) return null;
  if (text.length > TOKENIZE_MAX_CHARS) return null;
  try {
    return encoderOf(encodingNameOf(model)).encode(text).length;
  } catch {
    return null;
  }
}

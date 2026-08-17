import { asArray, asRecord } from '../internal/util';
import type { Usage } from '../types';
import { resolveCalibration, type TextTokenWeights } from './calibration';

/**
 * token 估算单一真相（usage 缺失时的兜底，非精确计量——精确值以供应商 usage 为准）。
 *
 * 文本 token 估算 = 特征向量 × 权重（权重来自固定配置 calibration，CJK/单词/数字/符号分权）：
 *   - CJK（Han/假名/谚文）→ cjk 权重/字（默认 0.7）
 *   - 拉丁字母连续段（单词）→ word 权重/段（默认 1.1）
 *   - 数字连续段 → number 权重/段（默认 1.0）
 *   - 其他非空白（标点/符号/emoji）→ symbol 权重/个（默认 1.0）
 *   - 空白 0；遍历按 code point（emoji/astral 不因 UTF-16 双计）
 *
 * 结构提取口径：
 *   - 输入：messages.content + 历史 tool_calls + tools 定义体 + embeddings input + 媒体非零下限
 *           + templateInputOffset（供应商注入的 chat template 固定开销，校准配置提供）
 *   - 输出：全量 choices（n>1 全计），content/reasoning/tool_calls/text（无 template 偏移）
 */

/** 媒体 part（image_url/audio/video/file）的保守 token 下限（OpenAI low-detail 图 base 量级）。 */
const MEDIA_PART_TOKEN_FLOOR = 85;

/** 估算上下文（provider/model 用于解析按供应商覆盖的权重与 template 偏移）。 */
export interface EstimateOptions {
  providerName?: string;
  model?: string;
}

/** 文本 token 特征向量（估算内部分类口径）。 */
export interface TextTokenFeatures {
  cjkChars: number;
  wordSegments: number;
  numberSegments: number;
  symbolCount: number;
}

function codePoint(ch: string): number {
  return ch.codePointAt(0) ?? 0;
}

function isCJK(ch: string): boolean {
  const cp = codePoint(ch);
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x20000 && cp <= 0x2ebef) || // 扩展 B–F（含兼容补充）
    (cp >= 0xf900 && cp <= 0xfaff) || // 兼容表意
    (cp >= 0x3040 && cp <= 0x30ff) || // 日文假名
    (cp >= 0xac00 && cp <= 0xd7af) // 谚文
  );
}

function isLatin(ch: string): boolean {
  const cp = codePoint(ch);
  return (
    (cp >= 0x41 && cp <= 0x5a) || // A-Z
    (cp >= 0x61 && cp <= 0x7a) || // a-z
    (cp >= 0x00c0 && cp <= 0x024f) // Latin-1 Supplement + Latin Extended-A/B
  );
}

function isNumber(ch: string): boolean {
  const cp = codePoint(ch);
  return cp >= 0x30 && cp <= 0x39; // 0-9
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/** 文本 → 特征向量（单一真相：estimateTextTokens 与样本记录共用同一分类）。 */
export function extractTextFeatures(text: string): TextTokenFeatures {
  const f: TextTokenFeatures = { cjkChars: 0, wordSegments: 0, numberSegments: 0, symbolCount: 0 };
  if (!text) return f;
  let segment: 'word' | 'number' | null = null;
  for (const ch of text) {
    if (isCJK(ch)) {
      f.cjkChars += 1;
      segment = null;
    } else if (isLatin(ch)) {
      if (segment !== 'word') {
        f.wordSegments += 1;
        segment = 'word';
      }
    } else if (isNumber(ch)) {
      if (segment !== 'number') {
        f.numberSegments += 1;
        segment = 'number';
      }
    } else if (isWhitespace(ch)) {
      segment = null;
    } else {
      f.symbolCount += 1;
      segment = null;
    }
  }
  return f;
}

/** 文本 → token 估算（特征向量 × 权重）。空文本返回 0。 */
export function estimateTextTokens(text: string, weights?: TextTokenWeights): number {
  const w = weights ?? resolveCalibration().weights;
  const f = extractTextFeatures(text);
  const raw =
    f.cjkChars * w.cjk +
    f.wordSegments * w.word +
    f.numberSegments * w.number +
    f.symbolCount * w.symbol;
  return Math.round(raw);
}

/** 是否媒体 part（image_url/audio/video/file 等非文本内容）。 */
function isMediaPart(p: Record<string, unknown>): boolean {
  const type = p.type;
  return (
    type === 'image_url' ||
    type === 'image' ||
    type === 'input_image' ||
    type === 'audio' ||
    type === 'input_audio' ||
    type === 'video' ||
    type === 'file' ||
    p.image_url !== undefined ||
    p.input_image !== undefined ||
    p.input_audio !== undefined ||
    p.audio !== undefined
  );
}

/** content（string 或 OpenAI 多模态 part 数组）→ token 估算。 */
function estimateContent(content: unknown, weights: TextTokenWeights): number {
  if (typeof content === 'string') return estimateTextTokens(content, weights);
  if (Array.isArray(content)) {
    let n = 0;
    for (const part of content) {
      const p = asRecord(part);
      if (!p) continue;
      if (typeof p.text === 'string') n += estimateTextTokens(p.text, weights);
      else if (isMediaPart(p)) n += MEDIA_PART_TOKEN_FLOOR;
    }
    return n;
  }
  return 0;
}

/** tool_calls 数组 → token 估算（function.name + arguments 是函数调用主要 token 源）。 */
function estimateToolCalls(toolCalls: unknown, weights: TextTokenWeights): number {
  const list = asArray(toolCalls);
  if (!list) return 0;
  let n = 0;
  for (const tc of list) {
    const fn = asRecord(asRecord(tc)?.function);
    if (fn) n += estimateTextTokens(`${fn.name ?? ''}${fn.arguments ?? ''}`, weights);
  }
  return n;
}

/**
 * 请求体 → 输入 token 估算。
 * 覆盖 messages.content + 历史 tool_calls + tools 定义体 + embeddings input + 媒体非零下限
 * + templateInputOffset（供应商注入开销）。
 */
export function estimateInputTokens(body: unknown, opts: EstimateOptions = {}): number {
  const rec = asRecord(body);
  if (!rec) return 0;
  const { weights, templateInputOffset } = resolveCalibration(opts.providerName, opts.model);
  let n = 0;
  const messages = asArray(rec.messages);
  if (messages) {
    for (const m of messages) {
      const msg = asRecord(m);
      if (!msg) continue;
      n += estimateContent(msg.content, weights);
      n += estimateToolCalls(msg.tool_calls, weights);
    }
  }
  // tools 定义体：企业 Agent 工具调用的主要输入 token 消耗源
  const tools = asArray(rec.tools);
  if (tools && tools.length > 0) {
    try {
      n += estimateTextTokens(JSON.stringify(tools), weights);
    } catch {
      /* 循环引用等异常 → 跳过，不破坏估算 */
    }
  }
  // embeddings：input 为 string / string[] / token-id 数组（number[] / number[][]）
  if (typeof rec.input === 'string') {
    n += estimateTextTokens(rec.input, weights);
  } else if (Array.isArray(rec.input)) {
    for (const item of rec.input) {
      if (typeof item === 'string') n += estimateTextTokens(item, weights);
      // token-id 数组：每 id 即一个 token（OpenAI 官方形态，跳过会低估预扣）
      else if (typeof item === 'number') n += 1;
      else if (Array.isArray(item)) n += item.length;
    }
  }
  // 生成类端点（images/video/music）与 rerank 的顶层 prompt/query：
  // 混合计价（token 价 + 单位价并存）时 token 分量的预扣来源
  if (typeof rec.prompt === 'string') n += estimateTextTokens(rec.prompt, weights);
  if (typeof rec.query === 'string') n += estimateTextTokens(rec.query, weights);
  return n + templateInputOffset;
}

/**
 * 响应 JSON → 输出 token 估算。
 * 全量 choices（n>1 全计），覆盖 content + reasoning + tool_calls + 补全类 text（无 template 偏移）。
 */
export function estimateOutputTokens(json: unknown, opts: EstimateOptions = {}): number {
  const rec = asRecord(json);
  if (!rec) return 0;
  const { weights } = resolveCalibration(opts.providerName, opts.model);
  const choices = asArray(rec.choices);
  if (!choices) return 0;
  let n = 0;
  for (const choice of choices) {
    const c = asRecord(choice);
    if (!c) continue;
    const message = asRecord(c.message);
    if (message) {
      n += estimateContent(message.content, weights);
      for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
        if (typeof message[key] === 'string') n += estimateTextTokens(message[key], weights);
      }
      n += estimateToolCalls(message.tool_calls, weights);
    }
    if (typeof c.text === 'string') n += estimateTextTokens(c.text, weights); // 补全类响应
  }
  return n;
}

/** usage 缺失兜底：请求/响应按字符估算，全部按未缓存计（estimated=true，非计费诊断值）。 */
export function estimateUsage(
  reqBody: unknown,
  resJson: unknown,
  opts: EstimateOptions = {},
): Usage {
  return {
    inputTokens: estimateInputTokens(reqBody, opts),
    cachedInputTokens: 0,
    outputTokens: estimateOutputTokens(resJson, opts),
    estimated: true,
    raw: null,
  };
}

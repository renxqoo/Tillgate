import { DEFAULT_MAX_LINE_BYTES } from './sse';

/**
 * 响应侧 model 字段替换（可配置开关、默认关）：
 * 出站 SSE 帧内仅替换 "model" 字符串值为对外目录模型名，其余字节不动；
 * 逐行状态机（行缓冲受 DEFAULT_MAX_LINE_BYTES 上界约束），不整流缓冲——
 * 每个 push 只处理已完成行并立即吐出，半截行留待下一 chunk 补齐（有界）。
 *
 * 字节保真口径：非 data 行、[DONE]、非 JSON 或无顶层 model 字段的 data 行原样透出；
 * 命中行只替换 model 值字节（键名与冒号间距原样保留）。UTF-8 经流式解码再编码，
 * 对合法 UTF-8 流逐字节等价（SSE 规范要求 UTF-8）。
 */

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();

/** data 行内首个 "model" 字符串字段（键 + 冒号间距保形，值整体替换） */
const MODEL_FIELD_RE = /("model")(\s*:\s*)(?:"(?:[^"\\]|\\.)*")/;

/** 单行 data 载荷的 model 值替换（非 data 行 / 非法 JSON / 无顶层 model → 原样返回） */
export function rewriteModelInDataLine(line: string, model: string): string {
  if (!line.startsWith('data:')) return line;
  const rest = line.slice(5);
  const payload = rest.replace(/^ /, '');
  const leadingSpace = rest.startsWith(' ') ? ' ' : '';
  if (payload === '[DONE]') return line;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return line;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return line;
  if (typeof (parsed as Record<string, unknown>).model !== 'string') return line;
  const m = MODEL_FIELD_RE.exec(payload);
  if (m === null) return line;
  const replaced =
    payload.slice(0, m.index) +
    m[1] +
    m[2] +
    JSON.stringify(model) +
    payload.slice(m.index + m[0].length);
  // 替换后必须仍是合法 JSON 且顶层 model 已更新（自愈兜底：任何意外都退回原行）
  try {
    const check = JSON.parse(replaced) as Record<string, unknown>;
    if (check.model !== model) return line;
  } catch {
    return line;
  }
  return `data:${leadingSpace}${replaced}`;
}

/**
 * 流式 model 改写器：push 进 chunk、吐出已完成行的改写字节；flush 补尾行。
 * 超过 maxLineBytes 的半截行抛英文错误终止流（内存上界，与 sse.ts 同源常量）。
 */
export class SseModelRewriter {
  private readonly decoder = new TextDecoder('utf-8');
  private carry = '';
  private carryBytes = 0;

  constructor(
    private readonly model: string,
    private readonly maxLineBytes: number = DEFAULT_MAX_LINE_BYTES,
  ) {}

  push(chunk: Uint8Array): Uint8Array {
    this.carryBytes += chunk.byteLength;
    this.carry += this.decoder.decode(chunk, { stream: true });
    let out = '';
    let nl: number;
    while ((nl = this.carry.indexOf('\n')) >= 0) {
      const raw = this.carry.slice(0, nl);
      this.carry = this.carry.slice(nl + 1);
      this.carryBytes -= encoder.encode(raw).length + 1; // 已消费行出账（含换行符字节）
      const cr = raw.endsWith('\r') ? '\r' : '';
      const body = cr !== '' ? raw.slice(0, -1) : raw;
      out += `${rewriteModelInDataLine(body, this.model) + cr}\n`;
    }
    if (this.carryBytes > this.maxLineBytes) {
      const limit = this.maxLineBytes;
      this.carry = '';
      this.carryBytes = 0;
      throw new Error(`SSE line exceeds maximum of ${limit} bytes during model rewrite`);
    }
    return out === '' ? EMPTY : encoder.encode(out);
  }

  /** 流末尾：解码器残余 + 半截行作为最后一行处理（无换行补不上） */
  flush(): Uint8Array {
    this.carry += this.decoder.decode();
    if (this.carry === '') return EMPTY;
    const body = this.carry.endsWith('\r') ? this.carry.slice(0, -1) : this.carry;
    this.carry = '';
    this.carryBytes = 0;
    return encoder.encode(rewriteModelInDataLine(body, this.model));
  }
}

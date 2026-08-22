import type { TextTokenFeatures } from '../types';

/**
 * 文本特征四计数器（token-estimate 启发式层的充分统计量，单一真相——v1 审计迁移）。
 * wordSegments 依赖相邻字符状态机（词段 ≠ 字符数），不可简化为字符数分类；
 * scanner 按片段统计后累加（求和可交换），替代 v1 outputText 文本累积（S1：
 * 4MB CAP → O(1) 内存），BPE 精确值作为独立分量随行（语义不降级）。
 */

const codePoint = (ch: string): number => ch.codePointAt(0) ?? 0;

export function isCJK(ch: string): boolean {
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

const isWhitespace = (ch: string): boolean => /\s/.test(ch);

/** 文本 → 特征向量（一次性统计；与 v1 逐字符状态机行为等价） */
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

/**
 * 流式特征累积器（scanner 热路径专用，O(1) 内存）：
 * 按片段统计后求和——与整段统计在数学上等价（四计数器对拼接可交换），
 * 但「片段边界重置词段状态」与逐段 extractTextFeatures 一致，
 * 拼接边界不会产生跨段词段（"hel"+"lo" = 2 段，整段 "hello" = 1 段——
 * 按 v1 片段调用语义保持，估算口径不因累积方式改变）。
 */
export class TextFeaturesAccumulator implements TextTokenFeatures {
  cjkChars = 0;
  wordSegments = 0;
  numberSegments = 0;
  symbolCount = 0;
  /** BPE 精确计数（文本现场可得时由调用方先行计算；估算层优先采用） */
  bpeExact: number | null = null;

  /** 喂入一个文本片段（每片段内部状态机独立，片段间断段） */
  addText(piece: string): void {
    if (!piece) return;
    let segment: 'word' | 'number' | null = null;
    for (const ch of piece) {
      if (isCJK(ch)) {
        this.cjkChars += 1;
        segment = null;
      } else if (isLatin(ch)) {
        if (segment !== 'word') {
          this.wordSegments += 1;
          segment = 'word';
        }
      } else if (isNumber(ch)) {
        if (segment !== 'number') {
          this.numberSegments += 1;
          segment = 'number';
        }
      } else if (isWhitespace(ch)) {
        segment = null;
      } else {
        this.symbolCount += 1;
        segment = null;
      }
    }
  }

  snapshot(): TextTokenFeatures {
    return {
      cjkChars: this.cjkChars,
      wordSegments: this.wordSegments,
      numberSegments: this.numberSegments,
      symbolCount: this.symbolCount,
    };
  }
}

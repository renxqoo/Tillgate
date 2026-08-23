/**
 * gemini codec 族共享小件（gemini-chat / gemini-stream 共用的纯形状归一件）。
 * 只放无方向的 JSON 形状判断与 finishReason 词表；方向性转换各自住在 sibling 文件。
 */

export type Json = Record<string, unknown>;

export function asJson(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}
export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** gemini finishReason → chat finish_reason（响应/流式出站共用方向） */
export const FINISH_MAP: Record<string, string> = {
  STOP: 'stop',
  MAX_TOKENS: 'length',
  SAFETY: 'content_filter',
  RECITATION: 'content_filter',
  OTHER: 'stop',
};

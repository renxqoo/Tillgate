/**
 * Claude 流式 codec 两方向共享的 stop_reason 映射（从 claude-stream.ts 按方向拆出：
 * 上游方向 claude-upstream-to-canonical.ts 与客户端方向 canonical-to-claude-stream.ts
 * 共用的纯映射表/纯函数住这里，单一真相）。
 */

/** claude stop_reason → OpenAI finish_reason（上游方向，message_delta 映射） */
export const STOP_REASON_MAP: Record<string, string> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

/** finish_reason → claude stop_reason（模块级纯函数，客户端方向） */
export const claudeStopOf = (finish: string | null): string | null => {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  if (finish === 'stop' || finish === null) return finish === null ? null : 'end_turn';
  return 'end_turn';
};

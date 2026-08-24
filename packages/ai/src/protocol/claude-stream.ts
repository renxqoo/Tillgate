/**
 * Claude Messages ⇄ OpenAI Chat 流式 codec 收口（纯 re-export，export 面不变）。
 * 实现按方向拆分（每个文件只装一个方向的流式转换动词）：
 *   ① claudeUpstreamToCanonicalStream   → claude-upstream-to-canonical.ts（上游侧）
 *   ② canonicalStreamToClaudeStream     → canonical-to-claude-stream.ts（客户端侧）
 * 两方向共享的 stop_reason 映射见 claude-stream-shared.ts；
 * 请求/响应/usage 的非流式 codec 见 claude-chat.ts。
 */
export { claudeUpstreamToCanonicalStream } from './claude-upstream-to-canonical';
export { canonicalStreamToClaudeStream } from './canonical-to-claude-stream';

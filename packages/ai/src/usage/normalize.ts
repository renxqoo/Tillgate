/**
 * usage 归一化：OpenAI cached_tokens / DeepSeek cache_hit+miss → Usage（骨架）
 */
// TODO(ai): 实现归一化矩阵：
//   - OpenAI 风格: prompt_tokens_details.cached_tokens → cachedInputTokens
//   - DeepSeek: prompt_cache_hit_tokens / prompt_cache_miss_tokens
//   - 无缓存字段 → cachedInputTokens = 0
//   - usage 缺失 → 按字符估算（estimate.charPerToken），estimated=true，全部按未缓存计
export type { Usage } from '../types.js'

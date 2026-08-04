import type { ParamRules, UpstreamError, Usage } from '../types.js'
import type { ParamAdjustment, ProtocolAdapter } from './protocol-adapter.js'

/** 一期唯一实现：OpenAI 兼容透传 + 规则抹平 + usage 归一化 + 错误映射 */
export class OpenAICompatibleAdapter implements ProtocolAdapter {
  readonly protocol = 'openai-compatible'

  // TODO(ai): 实现参数抹平执行引擎（ignore / clamp / map / unknown）
  normalizeRequest(
    _req: unknown,
    _rules: ParamRules,
  ): { body: unknown; adjustments: ParamAdjustment[] } {
    return { body: _req, adjustments: [] }
  }

  // TODO(ai): 实现 usage 归一化（OpenAI cached_tokens / DeepSeek cache_hit+miss）
  extractUsage(_res: unknown): Usage | null {
    return null
  }

  // TODO(ai): 实现错误分类矩阵 + 死凭据文本特征
  mapError(_status: number | undefined, _body: unknown): UpstreamError {
    throw new Error('not implemented')
  }

  probePaths(): string[] {
    return ['/v1/models']
  }
}

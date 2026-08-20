import type { ChannelDesc, ParamRules, UpstreamError, Usage } from '../types';
import type { ParamAdjustment, ProtocolAdapter } from './protocol-adapter';
import {
  chatRequestToClaude,
  claudeResponseToChat,
  claudeUpstreamToCanonicalStream,
  claudeUsageToUsage,
} from '../protocol/claude-chat';
import { classifyHttpError } from '../errors/classify';

/**
 * Anthropic Messages 原生适配器（protocol='anthropic'）。
 *
 * 寻址：POST /v1/messages，x-api-key + anthropic-version。
 * 规范形⇄原生：请求 chatRequestToClaude（max_tokens 必填默认 4096）；
 * 响应/流经 translateResponseBody / translateUpstreamStream 归一为规范形。
 */
export const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicAdapter implements ProtocolAdapter {
  readonly protocol = 'anthropic';

  planRequest(channel: ChannelDesc, { requestId, stream }: { endpoint: 'chat' | 'embeddings'; model: string; requestId: string; stream: boolean }): { path: string; headers: Record<string, string> } {
    void stream;
    return {
      path: '/v1/messages',
      headers: {
        'x-api-key': channel.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        'idempotency-key': requestId,
      },
    };
  }

  finalizeRequestBody(body: Record<string, unknown>, { model, stream }: { endpoint: 'chat' | 'embeddings'; model: string; stream: boolean }): Record<string, unknown> {
    const claudeBody = chatRequestToClaude({ ...body, model });
    if (stream) claudeBody.stream = true;
    return claudeBody;
  }

  normalizeRequest(req: unknown, _rules: ParamRules): { body: unknown; adjustments: ParamAdjustment[] } {
    // 规范形基底（chat 参数语义）+ claude 特有参数透传
    return { body: req, adjustments: [] as ParamAdjustment[] };
  }

  translateResponseBody(body: unknown): unknown {
    return claudeResponseToChat(body);
  }

  translateUpstreamStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return claudeUpstreamToCanonicalStream(stream);
  }

  extractUsage(res: unknown): Usage | null {
    // res 已是规范形（create-ai 先走 translateResponseBody）；兜底直接认 claude 形
    const usage = extractOpenAiUsage(res);
    if (usage) return usage;
    const u = claudeUsageToUsage((res as Record<string, unknown>)?.usage);
    return u
      ? {
          inputTokens: u.promptTokens,
          cachedInputTokens: u.cachedTokens,
          outputTokens: u.completionTokens,
          estimated: false,
          // 缓存写入 token（5m+1h 合计）——计费消费属独立资金工单，先捕获
          ...(u.cacheCreationTokens > 0 ? { cacheWriteTokens: u.cacheCreationTokens } : {}),
          raw: (res as Record<string, unknown>)?.usage,
        }
      : null;
  }

  mapError(status: number | undefined, body: unknown): UpstreamError {
    const err = classifyHttpError(status ?? 0, body);
    // claude 错误体 {type:'error', error:{type:'authentication_error',...}} → 死凭据特征
    const inner = (body as Record<string, unknown> | null)?.error;
    if (typeof inner === 'object' && inner !== null) {
      const type = (inner as Record<string, unknown>).type;
      if (type === 'authentication_error') {
        return { ...err, code: 'invalid_api_key', deadCredential: true };
      }
      if (type === 'permission_error' || type === 'not_found_error') {
        return { ...err, code: type === 'not_found_error' ? 'model_not_found' : 'forbidden' };
      }
      if (type === 'rate_limit_error') return { ...err, code: 'rate_limited' };
      if (type === 'overloaded_error') return { ...err, code: 'upstream_overloaded', retryable: true };
    }
    return err;
  }

  probeRequests(channel: ChannelDesc): { path: string; headers: Record<string, string> }[] {
    return [
      {
        path: '/v1/models',
        headers: { 'x-api-key': channel.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      },
    ];
  }
}

function extractOpenAiUsage(res: unknown): Usage | null {
  const j = res as Record<string, unknown> | null;
  const usage = j?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage.prompt_tokens !== 'number' || typeof usage.completion_tokens !== 'number') {
    return null;
  }
  const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
  const cacheWrite = usage.cache_write_tokens;
  return {
    inputTokens: usage.prompt_tokens,
    cachedInputTokens: typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0,
    ...(typeof cacheWrite === 'number' && cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    outputTokens: usage.completion_tokens,
    estimated: false,
    raw: usage,
  };
}

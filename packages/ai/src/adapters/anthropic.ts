import { extractOpenAiUsage } from './shared';
import type {
  Endpoint, ChannelDesc, ParamRules, UpstreamError, Usage } from '../types';
import type { ParamAdjustment, ProtocolAdapter } from './protocol-adapter';
import {
  chatRequestToClaude,
  claudeResponseToChat,
  claudeUpstreamToCanonicalStream,
  claudeUsageToUsage,
} from '../protocol/claude-chat';
import { tableOrFallback } from '../errors/fallback';
import type { ErrorKind } from '../errors/kinds';

/** anthropic error.type → kind（v1 修正知识表化） */
const ANTHROPIC_TYPE_KINDS: Record<string, ErrorKind> = {
  authentication_error: 'invalid_api_key',
  permission_error: 'insufficient_permissions',
  not_found_error: 'model_not_found',
  rate_limit_error: 'rate_limited',
  overloaded_error: 'overloaded',
  invalid_request_error: 'invalid_request',
  api_error: 'upstream_error',
};

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
  readonly supportedEndpoints: readonly Endpoint[] = ['chat'];

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

  mapError(status: number | undefined, body: unknown, headers?: Record<string, string>): UpstreamError {
    return tableOrFallback({ table: ANTHROPIC_TYPE_KINDS, status, body, headers });
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


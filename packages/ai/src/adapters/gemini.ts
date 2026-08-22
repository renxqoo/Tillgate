import type {
  Endpoint, ChannelDesc, ParamRules, UpstreamError, Usage } from '../types';
import type { ParamAdjustment, ProtocolAdapter } from './protocol-adapter';
import {
  chatRequestToGemini,
  geminiResponseToChat,
  geminiUpstreamToCanonicalStream,
  geminiUsageToUsage,
} from '../protocol/gemini-chat';
import { tableOrFallback } from '../errors/fallback';
import type { ErrorKind } from '../errors/kinds';

/** gemini error.status → kind（v1 修正知识表化；extractVendorCode 读 error.status） */
export const GEMINI_STATUS_KINDS: Record<string, ErrorKind> = {
  UNAUTHENTICATED: 'invalid_api_key',
  PERMISSION_DENIED: 'insufficient_permissions',
  RESOURCE_EXHAUSTED: 'rate_limited',
  NOT_FOUND: 'model_not_found',
  INVALID_ARGUMENT: 'invalid_request',
  UNAVAILABLE: 'upstream_error',
};

/**
 * Gemini 原生适配器（protocol='gemini'）。
 *
 * 寻址：/v1beta/models/{model}:{generateContent|streamGenerateContent?alt=sse}
 * 认证：x-goog-api-key（AI Studio key）。
 */
export class GeminiAdapter implements ProtocolAdapter {
  readonly protocol = 'gemini';
  readonly supportedEndpoints: readonly Endpoint[] = ['chat'];

  planRequest(channel: ChannelDesc, { model, requestId, stream }: { endpoint: 'chat' | 'embeddings'; model: string; requestId: string; stream: boolean }): { path: string; headers: Record<string, string> } {
    const action = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    return {
      path: `/v1beta/models/${encodeURIComponent(model)}:${action}`,
      headers: {
        'x-goog-api-key': channel.apiKey,
        'content-type': 'application/json',
        'idempotency-key': requestId,
      },
    };
  }

  finalizeRequestBody(body: Record<string, unknown>, { model, stream }: { endpoint: 'chat' | 'embeddings'; model: string; stream: boolean }): Record<string, unknown> {
    const geminiBody = chatRequestToGemini({ ...body, model });
    if (stream) delete (geminiBody as Record<string, unknown>).stream;
    return geminiBody;
  }

  normalizeRequest(req: unknown, _rules: ParamRules, _endpoint: Endpoint): { body: unknown; adjustments: ParamAdjustment[] } {
    void _endpoint;
    return { body: req, adjustments: [] as ParamAdjustment[] };
  }

  translateResponseBody(body: unknown): unknown {
    return geminiResponseToChat(body, '');
  }

  translateUpstreamStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return geminiUpstreamToCanonicalStream(stream);
  }

  extractUsage(res: unknown): Usage | null {
    const j = res as Record<string, unknown> | null;
    const usage = geminiUsageToUsage(j?.usageMetadata);
    if (usage) {
      return { inputTokens: usage.promptTokens, cachedInputTokens: usage.cachedTokens, outputTokens: usage.completionTokens, estimated: false, raw: j?.usageMetadata };
    }
    // 规范形 usage（translate 后）
    const openaiUsage = j?.usage as Record<string, unknown> | undefined;
    if (openaiUsage && typeof openaiUsage.prompt_tokens === 'number' && typeof openaiUsage.completion_tokens === 'number') {
      const details = openaiUsage.prompt_tokens_details as Record<string, unknown> | undefined;
      return {
        inputTokens: openaiUsage.prompt_tokens,
        cachedInputTokens: typeof details?.cached_tokens === 'number' ? details.cached_tokens : 0,
        outputTokens: openaiUsage.completion_tokens,
        estimated: false,
        raw: openaiUsage,
      };
    }
    return null;
  }

  mapError(status: number | undefined, body: unknown, headers?: Record<string, string>): UpstreamError {
    return tableOrFallback({ table: GEMINI_STATUS_KINDS, status, body, headers });
  }

  probeRequests(channel: ChannelDesc): { path: string; headers: Record<string, string> }[] {
    return [
      {
        path: '/v1beta/models',
        headers: { 'x-goog-api-key': channel.apiKey },
      },
    ];
  }
}

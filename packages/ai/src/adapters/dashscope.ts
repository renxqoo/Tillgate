import { tableOrFallback } from '../errors/fallback';
import type { ErrorKind } from '../errors/kinds';

/** dashscope 顶层 code 前缀 → kind（Throttling.* 系 window 限流；Arrearage 余额） */
const DASHSCOPE_CODE_KINDS: Record<string, ErrorKind> = {
  InvalidApiKey: 'invalid_api_key',
  Arrearage: 'quota_exhausted',
  Throttling: 'rate_limited',
  Throttling_RateQuota: 'rate_limited',
  Throttling_AllocationQuota: 'quota_exhausted',
  BadRequest: 'invalid_request',
  InvalidParameter: 'invalid_request',
  ModelNotFound: 'model_not_found',
  InternalError: 'upstream_error',
};
import { asRecord } from '../internal/util';
import type { ChannelDesc, Endpoint, ParamRules, UpstreamError, Usage } from '../types';
import type { ParamAdjustment, ProtocolAdapter, UpstreamRequestPlan } from './protocol-adapter';
import { OpenAICompatibleAdapter } from './openai-compatible';

/**
 * DashScope（阿里百炼）原生协议适配器：
 *
 * 背景（2026-08-21 实测）：DashScope 的 OpenAI 兼容模式只覆盖 chat/embeddings——
 * /v1/images/generations 直连 404；qwen-image 系列只能走原生
 * multimodal-generation 同步 API（X-DashScope-Async 异步头对新式 key 报
 * "does not support asynchronous calls"）。该协议把两者合一：
 *   - images 端点 → 原生线格式（input.messages[].content[].text + parameters）
 *   - chat/embeddings 端点 → compatible-mode（与 openai-compatible 同形）
 * 响应方向：原生形经 translateResponseBody 归一为 OpenAI images 规范形
 * （data[].url + usage.image_count）——计量注册表 imageUnits 数 data.length
 * 即拿到结算张数，管线其余部分零感知。
 *
 * base_url 约定：根域名（https://dashscope.aliyuncs.com），不带尾部路径。
 */
export class DashScopeAdapter extends OpenAICompatibleAdapter implements ProtocolAdapter {
  readonly protocol: string = 'dashscope';
  readonly supportedEndpoints: readonly Endpoint[] = ['chat', 'embeddings', 'images'];

  /** 寻址：images=原生 multimodal-generation；其余=compatible-mode（OpenAI 形路径） */
  planRequest(
    channel: ChannelDesc,
    input: { endpoint: Endpoint; model: string; requestId: string; stream: boolean },
  ): UpstreamRequestPlan {
    if (input.endpoint === 'images') {
      return {
        path: '/api/v1/services/aigc/multimodal-generation/generation',
        headers: {
          authorization: `Bearer ${channel.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': input.requestId,
        },
      };
    }
    if (input.endpoint === 'embeddings') {
      return {
        path: '/compatible-mode/v1/embeddings',
        headers: {
          authorization: `Bearer ${channel.apiKey}`,
          'content-type': 'application/json',
          'idempotency-key': input.requestId,
        },
      };
    }
    return {
      path: '/compatible-mode/v1/chat/completions',
      headers: {
        authorization: `Bearer ${channel.apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': input.requestId,
      },
    };
  }

  /**
   * 请求体终态化：
   * - images：OpenAI 形（prompt/n/size…）→ DashScope 形（prompt 进 input.messages，
   *   其余非 model 参数全部进 parameters——size/n/负向词等由上游校验）
   * - 其余端点：落 OpenAI 兼容终改（model 重写 + 流式 usage 注入）
   */
  finalizeRequestBody(
    body: Record<string, unknown>,
    input: { endpoint: Endpoint; model: string; stream: boolean },
  ): Record<string, unknown> {
    if (input.endpoint !== 'images') return super.finalizeRequestBody(body, input);
    const parameters: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (key === 'model' || key === 'prompt' || key === 'stream') continue;
      parameters[key] = value;
    }
    const out: Record<string, unknown> = {
      model: input.model,
      input: {
        messages: [
          { role: 'user', content: [{ text: typeof body.prompt === 'string' ? body.prompt : '' }] },
        ],
      },
    };
    if (Object.keys(parameters).length > 0) out.parameters = parameters;
    return out;
  }

  /** 原生形 → 规范形；已是规范形（无 output.choices）原样返回（幂等兜底） */
  translateResponseBody(body: unknown): unknown {
    const record = asRecord(body);
    const output = asRecord(record?.output);
    const choices = output?.choices;
    if (!Array.isArray(choices)) return body;
    const urls: string[] = [];
    for (const choice of choices) {
      const content = asRecord(asRecord(choice)?.message)?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        const url = asRecord(part)?.image;
        if (typeof url === 'string' && url !== '') urls.push(url);
      }
    }
    const usage = asRecord(record?.usage);
    const width = typeof usage?.width === 'number' ? usage.width : null;
    const height = typeof usage?.height === 'number' ? usage.height : null;
    const size = width != null && height != null ? `${width}*${height}` : undefined;
    const imageCount =
      typeof usage?.image_count === 'number' && usage.image_count > 0
        ? usage.image_count
        : urls.length;
    return {
      object: 'list',
      created: Math.floor(Date.now() / 1000),
      data: urls.map((url) => ({ url, ...(size != null ? { size } : {}) })),
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, image_count: imageCount },
    };
  }

  /** 计量：规范形 usage.image_count → units（张）；chat 族落 OpenAI usage 归一 */
  extractUsage(res: unknown): Usage | null {
    const usage = asRecord(asRecord(res)?.usage);
    if (usage != null && typeof usage.image_count === 'number') {
      return {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        estimated: false,
        units: usage.image_count,
        raw: usage,
      };
    }
    return super.extractUsage(res);
  }

  /** 错误映射：DashScope 错误体 {code, message, request_id} 走通用分类矩阵 */
  mapError(
    status: number | undefined,
    body: unknown,
    headers?: Record<string, string>,
  ): UpstreamError {
    return tableOrFallback({ table: DASHSCOPE_CODE_KINDS, status, body, headers });
  }

  /** 连通性探测：compatible-mode /models（GET，轻量鉴权验证） */
  probeRequests(channel: ChannelDesc): Array<{ path: string; headers: Record<string, string> }> {
    return [
      {
        path: '/compatible-mode/v1/models',
        headers: { authorization: `Bearer ${channel.apiKey}` },
      },
    ];
  }

  /** 参数抹平：本协议不做模型级参数规则（images 参数由 finalize 收敛进 parameters） */
  normalizeRequest(
    req: unknown,
    _rules: ParamRules,
    _endpoint: Endpoint,
  ): { body: unknown; adjustments: ParamAdjustment[] } {
    void _rules;
    void _endpoint;
    return { body: req, adjustments: [] };
  }
}

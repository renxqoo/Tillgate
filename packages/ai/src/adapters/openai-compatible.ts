import { classifyHttpError } from '../errors/classify';
import { asRecord } from '../internal/util';
import { normalizeUsage } from '../usage/normalize';
import type { ChannelDesc, ParamRules, UpstreamError, Usage } from '../types';
import type { ParamAdjustment, ProtocolAdapter } from './protocol-adapter';

/**
 * OpenAI 兼容适配器（默认注册：'openai-compatible'）：
 *   - 寻址：chat → /v1/chat/completions、embeddings → /v1/embeddings；Bearer 认证
 *   - 请求方向：透传为基底，按规则抹平（执行顺序 ignore → map → clamp → unknown drop）
 *   - 请求体终改：model 重写（对外名→真实名）+ 流式 stream_options 强制注入
 *   - 响应方向：仅提取计量与错误，正文透传
 *   - map 在 clamp 前：clamp 规则键针对「映射后的最终参数名」编写（如 o 系列 max_completion_tokens 上限）
 */

/** OpenAI chat.completions 已知参数（unknown:'drop' 判定用；map 目标名额外视为已知） */
const CHAT_KNOWN_PARAMS = new Set([
  'model',
  'messages',
  'temperature',
  'top_p',
  'n',
  'stream',
  'stream_options',
  'stop',
  'max_tokens',
  'max_completion_tokens',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'user',
  'response_format',
  'seed',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'function_call',
  'functions',
  'metadata',
  'service_tier',
  'reasoning_effort',
]);

export class OpenAICompatibleAdapter implements ProtocolAdapter {
  readonly protocol = 'openai-compatible';

  /** 上游寻址：endpoint 决定路径；认证头带幂等键（见下方 finalizeRequestBody 上方 C5 注释） */
  planRequest(
    channel: ChannelDesc,
    input: { endpoint: 'chat' | 'embeddings'; model: string; requestId: string },
  ): { path: string; headers: Record<string, string> } {
    return {
      path: input.endpoint === 'embeddings' ? '/v1/embeddings' : '/v1/chat/completions',
      headers: {
        authorization: `Bearer ${channel.apiKey}`,
        'content-type': 'application/json',
        // C5 修复：Idempotency-Key（= requestId）。withRetry 在 retryable 错误时会重发 POST，
        // 若上游已处理首请求（仅响应丢失/超时），重试会触发第二次生成 → 供应商成本翻倍。
        // Idempotency-Key 让供应商侧按 requestId 去重（OpenAI/多数供应商支持该头）。
        'idempotency-key': input.requestId,
      },
    };
  }

  /**
   * 请求体终态化：
   * 1) model 重写：对外名 externalName → 上游真实名 realModel（ctx.model）。
   *    normalizeRequest 把 model 视为已知参数原样保留，从不改写；
   *    若不在此覆盖，发往上游的 body.model 会是客户端原始 externalName，
   *    与渠道实际服务的上游模型不符（如 external=deepseek-v4-pro 发给了只认 deepseek-chat 的官方）。
   * 2) 流式强制 stream_options（写死，不尊重用户传入）——usage 是流的随行状态，不是尾帧附属品：
   *    - include_usage:true：尾帧 usage 的开关（MiniMax 实测缺省/显式 false → 全程无 usage → 漏计费）
   *    - continuous_usage_stats:true：要求逐帧累计 usage（OpenAI 系生效——客户端取消时
   *      scanner 已持最新累计值，可直接结算；MiniMax 实测忽略该键、不报错）
   *    计费数据完整性优先于用户偏好；其余键透传。null usage 帧由 scanner 忽略（不覆盖真值）。
   */
  finalizeRequestBody(
    body: Record<string, unknown>,
    input: { endpoint: 'chat' | 'embeddings'; model: string; stream: boolean },
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { ...body, model: input.model };
    if (input.stream) {
      out.stream_options = {
        ...(asRecord(out.stream_options) as Record<string, unknown> | undefined),
        include_usage: true,
        continuous_usage_stats: true,
      };
    }
    return out;
  }

  normalizeRequest(
    req: unknown,
    rules: ParamRules,
  ): { body: unknown; adjustments: ParamAdjustment[] } {
    const body = asRecord(req);
    if (!body) return { body: req, adjustments: [] }; // 非对象透传底线：不破坏请求
    const adjustments: ParamAdjustment[] = [];
    const out: Record<string, unknown> = { ...body };

    // 1) ignore：删除该模型不支持的参数
    for (const name of rules.ignore ?? []) {
      if (name in out) {
        adjustments.push({ param: name, action: 'ignore', from: out[name] });
        delete out[name];
      }
    }

    // 2) map：参数改名（后到者覆盖同名目标）。
    //    原型键防护：目标名命中 __proto__/constructor/prototype 时跳过——
    //    out[to] 赋值会触发 __proto__ setter 改写本地原型（管理员误配置即畸形请求体）。
    for (const [name, { to }] of Object.entries(rules.map ?? {})) {
      if (name in out) {
        if (to === '__proto__' || to === 'constructor' || to === 'prototype') continue;
        adjustments.push({ param: name, action: 'map', from: out[name], to });
        out[to] = out[name];
        delete out[name];
      }
    }

    // 3) clamp：对最终参数名钳制（数值超范围 → 钳到边界）
    for (const [name, range] of Object.entries(rules.clamp ?? {})) {
      const v = out[name];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      let clamped = v;
      if (range.max !== undefined && clamped > range.max) clamped = range.max;
      if (range.min !== undefined && clamped < range.min) clamped = range.min;
      if (clamped !== v) {
        adjustments.push({ param: name, action: 'clamp', from: v, to: clamped });
        out[name] = clamped;
      }
    }

    // 4) unknown: 'drop' → 删除未知参数（动作记 ignore，可观测）
    if (rules.unknown === 'drop') {
      const known = new Set(CHAT_KNOWN_PARAMS);
      for (const to of Object.values(rules.map ?? {})) known.add(to.to);
      for (const key of Object.keys(out)) {
        if (!known.has(key)) {
          adjustments.push({ param: key, action: 'ignore', from: out[key] });
          delete out[key];
        }
      }
    }

    return { body: out, adjustments };
  }

  /** 响应方向：仅提取计量（usage 归一化），正文透传 */
  extractUsage(res: unknown): Usage | null {
    const r = asRecord(res);
    return r ? normalizeUsage(r.usage) : null;
  }

  /** 错误映射：委托分类矩阵（含死凭据文本特征） */
  mapError(status: number | undefined, body: unknown): UpstreamError {
    return classifyHttpError(status ?? 0, body);
  }

  /** 连通性探测请求：优先 /v1/models（GET，无副作用，Bearer 认证） */
  probeRequests(channel: ChannelDesc): Array<{ path: string; headers: Record<string, string> }> {
    return [{ path: '/v1/models', headers: { authorization: `Bearer ${channel.apiKey}` } }];
  }
}

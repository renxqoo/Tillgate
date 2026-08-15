import { classifyHttpError } from '../errors/classify.js';
import { asRecord } from '../internal/util.js';
import { normalizeUsage } from '../usage/normalize.js';
import type { ParamRules, UpstreamError, Usage } from '../types.js';
import type { ParamAdjustment, ProtocolAdapter } from './protocol-adapter.js';

/**
 * OpenAI 兼容适配器（一期唯一实现）：
 *   - 请求方向：透传为基底，按规则抹平（执行顺序 ignore → map → clamp → unknown drop）
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

  /** 连通性探测路径：优先 /v1/models（GET，无副作用） */
  probePaths(): string[] {
    return ['/v1/models'];
  }
}

/**
 * defineAdapter 组合器（契约分粒度的扩展入口）：按能力件部分覆写，
 * 未指定件落 OpenAI 兼容默认——组合取代继承（如 Azure 只注册一个 addressing 件，
 * 不继承整个适配器）。新原生协议仍走全量实现 ProtocolAdapter。
 */
import { OpenAICompatibleAdapter } from '../adapters/openai-compatible';
import type {
  Addressing,
  BodyFinalizer,
  ErrorMapper,
  ProtocolAdapter,
  ProtocolTaskOps,
  UsageExtractor,
  WireCodec,
} from '../adapters/protocol-adapter';

export interface DefineAdapterInput {
  /** 协议键（注册表主键；重复注册启动即抛） */
  protocol: string;
  /** 寻址件（路径/认证头/探测/签名）——OpenAI 兼容厂商差异的主要覆写点 */
  addressing?: Partial<Addressing>;
  /** 请求方向件（抹平引擎/终改） */
  body?: Partial<BodyFinalizer>;
  /** usage 提取件 */
  usage?: Partial<UsageExtractor>;
  /** 错误映射件 */
  errors?: Partial<ErrorMapper>;
  /** 原生线格式编解码件（仅原生协议） */
  codec?: WireCodec;
  /** 异步生成任务操作面 */
  tasks?: ProtocolTaskOps;
  /** 能力声明面（缺省继承 openai-compatible 默认） */
  supportedEndpoints?: readonly import('../types').Endpoint[];
}

/** OpenAI 兼容默认件（缺省能力的委托目标——单一真相在 OpenAICompatibleAdapter） */
const defaults = new OpenAICompatibleAdapter();

export function defineAdapter(input: DefineAdapterInput): ProtocolAdapter {
  const addressing = { ...pickAddressing(defaults), ...input.addressing };
  const body = { ...pickBody(defaults), ...input.body };
  const usage = { ...pickUsage(defaults), ...input.usage };
  const errors = { ...pickErrors(defaults), ...input.errors };
  const adapter: ProtocolAdapter = {
    protocol: input.protocol,
    supportedEndpoints: input.supportedEndpoints ?? defaults.supportedEndpoints,
    planRequest: (channel, i) => addressing.planRequest(channel, i),
    probeRequests: (channel) => addressing.probeRequests(channel),
    ...(addressing.signRequest ? { signRequest: (args) => addressing.signRequest!(args) } : {}),
    normalizeRequest: (req, rules, endpoint) => body.normalizeRequest(req, rules, endpoint),
    finalizeRequestBody: (b, i) => body.finalizeRequestBody(b, i),
    extractUsage: (res) => usage.extractUsage(res),
    mapError: (status, b, headers) => errors.mapError(status, b, headers),
    ...(input.codec?.translateResponseBody
      ? { translateResponseBody: (b) => input.codec!.translateResponseBody!(b) }
      : {}),
    ...(input.codec?.translateUpstreamStream
      ? { translateUpstreamStream: (s) => input.codec!.translateUpstreamStream!(s) }
      : {}),
    ...(input.tasks ? { tasks: input.tasks } : {}),
  };
  return adapter;
}

function pickAddressing(a: ProtocolAdapter): Addressing {
  return {
    planRequest: (channel, input) => a.planRequest(channel, input),
    probeRequests: (channel) => a.probeRequests(channel),
    ...(a.signRequest ? { signRequest: (args) => a.signRequest!(args) } : {}),
  };
}

function pickBody(a: ProtocolAdapter): BodyFinalizer {
  return {
    normalizeRequest: (req, rules, endpoint) => a.normalizeRequest(req, rules, endpoint),
    finalizeRequestBody: (b, input) => a.finalizeRequestBody(b, input),
  };
}

function pickUsage(a: ProtocolAdapter): UsageExtractor {
  return { extractUsage: (res) => a.extractUsage(res) };
}

function pickErrors(a: ProtocolAdapter): ErrorMapper {
  return { mapError: (status, body) => a.mapError(status, body) };
}

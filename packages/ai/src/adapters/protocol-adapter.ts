import type {
  ChannelDesc,
  Endpoint,
  GenerationFileProbeResult,
  GenerationParsedResponse,
  GenerationTaskProbeResult,
  ParamAdjustment,
  ParamRules,
  UpstreamError,
  Usage,
} from '../types';

/**
 * ProtocolAdapter 契约（v2，S5 演进——见 IMPLEMENTATION.md §3.2/§3.3）：
 *   - normalizeRequest 携带 endpoint（unknown-drop 词表按端点取集，修 v1 潜伏雷）；
 *   - signRequest 参数通用化（日期由签名协议自带，amzDate 不再泄漏进通用钩子）；
 *   - 新增 supportedEndpoints 能力声明面（寻址覆写缺口静态可见，错路由编译期可查）；
 *   - mapError 归一为 kind 翻译表：结构查表 → status 兜底 → 档案文本 pattern；
 *     机制位由 errors/kinds 派生表单点得出，adapter 不得逐例声明。
 *
 * 一切协议特定行为都在这层：寻址（路径+认证头）、请求体终改、usage 提取、
 * 错误翻译、探测请求。编排层（pipeline/）只做通用编排，不出现协议字面量。
 *
 * 扩展两形态（registry/define-adapter）：全量实现本接口（原生协议）；
 * defineAdapter 部分覆写（OpenAI 兼容厂商差异——组合取代继承）。
 */

/** 能力件①：上游寻址（路径 + 认证头 + 签名钩子） */
export interface Addressing {
  planRequest(
    channel: ChannelDesc,
    input: { endpoint: Endpoint; model: string; requestId: string; stream: boolean },
  ): UpstreamRequestPlan;
  /** 连通性探测请求（GET，无副作用；依次尝试，任一 <400 即通） */
  probeRequests(channel: ChannelDesc): ProbeRequest[];
  /**
   * 请求签名钩子（仅签名协议需要，如 bedrock SigV4）：拿到最终 URL 与序列化
   * body 后计算认证头（签名依赖 body 哈希，无法在 planRequest 静态给出）。
   */
  signRequest?(args: { url: URL; body: string; apiKey: string; at: Date }): Promise<Record<string, string>> | Record<string, string>;
}

/** 能力件②：请求方向（参数抹平引擎 + 发送前终改） */
export interface BodyFinalizer {
  /**
   * 参数抹平（透传为基底，规则驱动；vendor profile 编译产物与 per-model 规则汇合）。
   * endpoint 参与：unknown:'drop' 的已知词表按端点取集。
   */
  normalizeRequest(
    req: unknown,
    rules: ParamRules,
    endpoint: Endpoint,
  ): { body: unknown; adjustments: ParamAdjustment[] };
  /**
   * 请求体终态化（发往上游前最后一次协议改写）：model 重写、stream_options 注入、
   * body 格式转换等。输入为 normalizeRequest 之后的 body。
   */
  finalizeRequestBody(
    body: Record<string, unknown>,
    input: { endpoint: Endpoint; model: string; stream: boolean },
  ): Record<string, unknown>;
}

/** 能力件③：usage 提取（仅计量，正文透传） */
export interface UsageExtractor {
  extractUsage(res: unknown): Usage | null;
}

/** 能力件④：错误翻译（厂商错误 → kind；查表顺序见文件头） */
export interface ErrorMapper {
  mapError(status: number | undefined, body: unknown, headers?: Record<string, string>): UpstreamError;
}

/** 能力件⑤：原生线格式 ⇄ 规范形编解码（仅原生协议需要） */
export interface WireCodec {
  translateResponseBody?(body: unknown): unknown;
  translateUpstreamStream?(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
}

/** 聚合契约 = 五能力件并集 */
export interface ProtocolAdapter
  extends Addressing, BodyFinalizer, UsageExtractor, ErrorMapper, Partial<WireCodec> {
  readonly protocol: string;
  /** 本适配器实际支持的端点集（能力声明面：缺失端点在寻址层显式报错） */
  readonly supportedEndpoints: readonly Endpoint[];
  /** 异步生成任务操作面（任务型协议可选实现，如 minimax）。 */
  tasks?: ProtocolTaskOps;
}

export type { ParamAdjustment };

/** 上游寻址计划 */
export interface UpstreamRequestPlan {
  /** 相对 baseUrl 的路径（支持 model 进 path 的协议） */
  path: string;
  /** 完整请求头（认证 + content-type + 协议特有头） */
  headers: Record<string, string>;
}

/** 探测/任务查询的 GET 请求形 */
export interface ProbeRequest {
  path: string;
  headers: Record<string, string>;
}

/** 任务族 kind 词表（Endpoint 的任务子集） */
export type ProtocolTaskKind = Extract<Endpoint, 'video' | 'music'>;

/** 任务型协议的任务操作面 */
export interface ProtocolTaskOps {
  parseResponse(kind: ProtocolTaskKind, body: unknown): GenerationParsedResponse;
  planTaskQuery(channel: ChannelDesc, taskId: string): ProbeRequest;
  parseTaskStatus(body: unknown): GenerationTaskProbeResult;
  planFileRetrieve(channel: ChannelDesc, fileId: string): ProbeRequest;
  parseFileRetrieve(body: unknown): GenerationFileProbeResult;
}

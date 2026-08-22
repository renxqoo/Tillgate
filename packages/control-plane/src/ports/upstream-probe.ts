/**
 * 上游探针 port：渠道连通性探测与模型最小成本生成测试的执行边界。
 * 实现由装配用 ai 库包装（每次新建实例——内存态熔断/死凭据不跨探针共享、不污染网关）；
 * 本包不 import ai（防环规则 §5.2：control-plane 不得反向依赖 inference 执行面）。
 */

/** 探针目标（密钥已解密——仅存在于探针调用内存内） */
export interface ProbeTarget {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly protocol: string;
}

/** 探针结果（上游失败也是探针结果，不是管理面错误） */
export interface ProbeOutcome {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface UpstreamProbe {
  /** 渠道连通性（如 openai-compatible 的 GET /v1/models；任一探测请求 <400 即通） */
  probeChannel(target: ProbeTarget): Promise<ProbeOutcome>;
  /**
   * 模型最小成本生成："1" + max_tokens=1 真实请求（请求内零重试）。
   * tokens = input + output 用量汇总（上游未回报则缺省）。
   */
  probeModel(
    target: ProbeTarget,
    model: string,
    ctx: { requestId: string },
  ): Promise<ProbeOutcome & { readonly tokens?: number }>;
}

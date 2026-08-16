export interface GatewayTiming {
  /** 请求绝对 deadline（GATEWAY_REQUEST_DEADLINE_MS） */
  deadlineMs: number;
  /** 流中段静默预算（ai config stream.inactivityTimeoutMs） */
  inactivityMs: number;
  /** 首字节预算（peek 与 inactivity 同源） */
  firstByteMs: number;
  /** 优雅停机宽限（GATEWAY_SHUTDOWN_GRACE_MS） */
  shutdownGraceMs: number;
}

/**
 * 启动期 fail-fast 校验：参数关系架空语义的配置必须在启动时拒绝，
 * 不得带病运行（如 deadline < firstByte+inactivity 时静默流永远到不了
 * inactivity 分类，全部按 request_cancelled 估算计费——审计 P1-9）。
 */
export function assertGatewayTiming(t: GatewayTiming): void {
  if (t.deadlineMs <= t.firstByteMs + t.inactivityMs) {
    throw new Error(
      `GATEWAY_REQUEST_DEADLINE_MS(${t.deadlineMs}ms) 必须 > 首字节预算(${t.firstByteMs}ms) + 流静默预算(${t.inactivityMs}ms)，` +
        '否则静默流全部被 deadline 抢先改判为用户取消（估算计费），inactivity 分类不可达',
    );
  }
  if (t.shutdownGraceMs <= 5_000) {
    throw new Error(
      `GATEWAY_SHUTDOWN_GRACE_MS(${t.shutdownGraceMs}ms) 必须 > 5000ms（宽限期结束前 5s 中止在途请求需要余量）`,
    );
  }
}

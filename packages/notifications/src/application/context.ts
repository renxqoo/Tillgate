/**
 * 用例调用上下文:请求链路锚 + 操作发起者。
 * 渠道管理为管理员操作;dispatch/enqueue 为系统操作。审计归属随 observability 波次
 * 消费此锚(IMPLEMENTATION §1.3 G1),不预留空字段。
 */

export type NotifyActor = { kind: 'admin'; id: number } | { kind: 'system' };

export interface NotifyContext {
  /** 链路锚:日志/未来审计行关联 */
  readonly requestId: string;
  readonly actor: NotifyActor;
}

/** 系统上下文(dispatch 循环默认——v1 notify-dispatch 的 actor 形状) */
export function systemContext(requestId: string): NotifyContext {
  return { requestId, actor: { kind: 'system' } };
}

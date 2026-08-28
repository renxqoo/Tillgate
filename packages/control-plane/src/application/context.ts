/**
 * 用例调用上下文：请求链路锚 + 操作发起者（审计归属的唯一来源——幂等指纹/审计行统一从此取）。
 * 不预留未消费的观测锚字段（traceParent 等），接口只声明真实消费面。
 */

export type Actor =
  | { kind: 'admin'; id: number }
  | { kind: 'user'; id: number }
  | { kind: 'system' };

export interface ControlContext {
  /** 链路锚：审计/日志/幂等关联 */
  readonly requestId: string;
  readonly actor: Actor;
}

/** 管理员操作者 id（非管理员操作返回 null——审计行 adminId 语义） */
export function adminIdOf(ctx: ControlContext): number | null {
  return ctx.actor.kind === 'admin' ? ctx.actor.id : null;
}

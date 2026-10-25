/**
 * 熔断即告警（issue #80）：渠道熔断（缺陷过阈或预算耗尽）时入箱
 * channel_disabled 事件——此前熔断只在管理台列表可见，运营数日才发现。
 *
 * 契约：fire-and-forget（调用方持有 catch，告警不反噬结算）；幂等键 = 渠道×触发请求
 * ——同一熔断事件只由恰好越过阈值的那张结算触发（alreadyBroken 守卫拦后续），
 * 重试同 requestId 必吸收；复核启用后再熔断是新事件（新 requestId），必告警
 * ——反弹场景不破告警（pr-review 路 C finding #1）。事件复用 v1 词表
 * channel_disabled（不新增契约）。
 */
export interface ChannelBreakAlertInput {
  readonly broken: boolean;
  readonly channelId: number | null;
  readonly defects: number | null;
  /** 触发本次熔断的结算请求（幂等键成分——重试同键吸收，新熔断新键必告） */
  readonly requestId: string;
  /** 熔断成因：usage_defects=缺陷过阈；budget_exhausted=预算耗尽 */
  readonly breakReason: 'usage_defects' | 'budget_exhausted' | null;
}

export interface NotifyEnqueue {
  enqueue(input: {
    event: string;
    payload: Record<string, unknown>;
    dedupeKey: string;
  }): Promise<void>;
}

/** 熔断告警桥（非熔断/无渠道 = no-op；入箱失败由调用方 catch） */
export async function channelBreakAlert(
  notifications: NotifyEnqueue,
  input: ChannelBreakAlertInput,
): Promise<void> {
  if (!input.broken || input.channelId == null) return;
  return await notifications.enqueue({
    event: 'channel_disabled',
    payload: {
      channelId: input.channelId,
      defects: input.defects,
      reason: input.breakReason ?? 'usage_defects',
    },
    dedupeKey: `channel-broken:${input.channelId}:${input.requestId}`,
  });
}

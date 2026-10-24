/**
 * 熔断即告警（issue #80）：结算验收门缺陷过阈熔断（broken=true）时入箱
 * channel_disabled 事件——此前熔断只在管理台列表可见，运营数日才发现。
 *
 * 契约：fire-and-forget（调用方持有 catch，告警不反噬结算）；同渠道×日幂等
 * （dedupe 吸收同日重复熔断）；事件复用 v1 词表 channel_disabled（不新增契约）。
 */
export interface ChannelBreakAlertInput {
  readonly broken: boolean;
  readonly channelId: number | null;
  readonly defects: number | null;
  /** 幂等日键来源（clock 注入可测） */
  readonly now: Date;
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
  const dayKey = input.now.toISOString().slice(0, 10).replace(/-/g, '');
  await notifications.enqueue({
    event: 'channel_disabled',
    payload: {
      channelId: input.channelId,
      defects: input.defects,
      reason: 'usage_evidence_defects',
    },
    dedupeKey: `channel-broken:${input.channelId}:${dayKey}`,
  });
}

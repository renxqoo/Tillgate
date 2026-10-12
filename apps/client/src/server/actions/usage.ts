'use server';

/** 小时趋势懒加载：切到「按小时」粒度时 TrendChart 内直接调用（server reference）。 */
import type { UsageTrendPage, UsageTrendRow } from '@tillgate/api-client';

import { createClientApi } from '../api';

/**
 * 失败返回 null（不抛——客户端对 null 走可重试降级态）；
 * 成功返回行数组（消费方即组件，不需要 envelope）。
 */
export async function loadHourlyTrendAction(): Promise<ReadonlyArray<UsageTrendRow> | null> {
  try {
    const res = await createClientApi().get<UsageTrendPage>('/v1/usage/trend?granularity=hour');
    return res.list ?? [];
  } catch {
    // 不可达 → null（组件展示可重试态，不误报「暂无数据」）
    return null;
  }
}

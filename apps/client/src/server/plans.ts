/**
 * 公开套餐目录读取（订阅页）：查询形态单点——
 * `?page=1&limit=100`（page_size 形态会被忽略截断；排序依赖后端默认序）。
 */
import { ApiError, type ClientApiClient, type PlanRow, type RowsPage } from '@tillgate/api-client';

export interface PlansResult {
  /** 按账户形态过滤后的套餐（企业=席位套餐 / 个人=非席位套餐） */
  plans: PlanRow[];
  error: string | null;
}

export async function fetchPlans(
  api: ClientApiClient,
  isEnterprise: boolean,
  fallbackError: string,
): Promise<PlansResult> {
  try {
    const data = await api.get<RowsPage<PlanRow>>('/v1/plans?page=1&limit=100');
    return {
      plans: (data.rows ?? []).filter((p) => (isEnterprise ? p.allowSeats : !p.allowSeats)),
      error: null,
    };
  } catch (error) {
    return { plans: [], error: error instanceof ApiError ? error.message : fallbackError };
  }
}

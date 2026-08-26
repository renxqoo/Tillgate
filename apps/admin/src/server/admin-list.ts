/**
 * 管理台列表页统一取数（v1 api-client/list fetchAdminList 行为等价）：
 * ?page=&limit= 查询构造在 api-client core（buildListQuery 同源），
 * 失败降级为 {rows:[], total:0, error} ——列表页不因后端不可达抛错整页崩。
 */
import { ApiError, buildListQuery } from '@tillgate/api-client';
import type {
  ListFetchOptions,
  Paginated,
  RateCardOption,
  AdminRateCardRow,
} from '@tillgate/api-client';
import { outgoingLocale } from '@tillgate/api-client/next';

import { adminApi } from './admin-api';
import { ADMIN_LOCALE_RESOLUTION } from './admin-locale';

export type { ListFetchOptions };

export interface ListFetchResult<T> {
  rows: T[];
  total: number;
  error: string | null;
}

export async function fetchAdminList<T>(
  path: string,
  opts: ListFetchOptions,
): Promise<ListFetchResult<T>> {
  try {
    const data = await adminApi().get<Paginated<T>>(`${path}?${buildListQuery(opts)}`);
    return { rows: (data.rows ?? []) as T[], total: data.total ?? 0, error: null };
  } catch (error) {
    return {
      rows: [],
      total: 0,
      error: await (async () => {
        if (error instanceof ApiError) return error.message;
        return (await outgoingLocale(ADMIN_LOCALE_RESOLUTION)) === 'zh'
          ? '加载失败'
          : 'Failed to load';
      })(),
    };
  }
}

/** 费率卡选项拉取（用户列表行/详情卡/绑定下拉共用）：失败降级空列表，不阻塞页面 */
export async function fetchRateCardOptions(): Promise<RateCardOption[]> {
  try {
    const rc = await adminApi().get<Paginated<AdminRateCardRow>>('/v1/rate-cards');
    return (rc.rows ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      coefficient: r.coefficient,
    }));
  } catch {
    return [];
  }
}

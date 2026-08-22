/**
 * ProviderStore port：供应商配置的持久化边界（PostgreSQL 可替换本地依赖，§5.6 类型 2）。
 * 方法首参 db 会话：写路径传事务句柄（application 持有事务），只读路径可传池句柄。
 * 重名交给 PG 唯一索引（23505 由 application 翻译 conflict）；删除 = 软退役。
 */
import type { DbLike } from '@tokenlens/db';
import type { ListQuery, ListResult } from '../domain/list';
import type { ProviderPatchInput } from '../domain/provider/provider';

export interface ProviderRecord {
  readonly id: number;
  readonly name: string;
  readonly protocol: string;
  readonly vendor: string | null;
  readonly baseUrl: string;
  readonly status: number;
  readonly createdAt: Date;
}

export type ProviderSortField = 'id' | 'name' | 'status' | 'createdAt';

export interface ProviderStore {
  insert(
    db: DbLike,
    input: {
      name: string;
      protocol: string;
      vendor: string | null;
      baseUrl: string;
      status: number;
    },
  ): Promise<ProviderRecord>;
  findById(db: DbLike, providerId: number): Promise<ProviderRecord | null>;
  /** 按名精确查（目录导入 find-or-create / 渠道导入供应商解析用） */
  findByName(db: DbLike, name: string): Promise<ProviderRecord | null>;
  /** 部分更新（仅白名单字段；0 行 = 不存在） */
  update(
    db: DbLike,
    input: { providerId: number; patch: ProviderPatchInput },
  ): Promise<ProviderRecord | null>;
  /** 软退役：status=1；false = 不存在 */
  retire(db: DbLike, input: { providerId: number }): Promise<boolean>;
  /** 统一列表：q 命中 name/baseUrl（字面匹配）；白名单排序 + id 决胜 */
  list(db: DbLike, query: ListQuery<ProviderSortField>): Promise<ListResult<ProviderRecord>>;
}

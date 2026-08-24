/**
 * ProviderStore port：供应商配置的持久化边界（PostgreSQL 可替换本地依赖，§5.6 类型 2）。
 * 方法首参 db 会话：写路径传事务句柄（application 持有事务），只读路径可传池句柄。
 * 重名交给 PG 部分唯一索引（23505 由 application 翻译 conflict——已删除行不占名）；
 * 禁用 = status=1（PATCH）；删除 = 逻辑删除回收站（softDelete）。
 */
import type { DbLike } from '@tillgate/db';
import type { ListQuery, ListResult } from '../domain/list';
import type { ProviderPatchInput } from '../domain/provider/provider';

export interface ProviderRecord {
  readonly id: number;
  readonly name: string;
  readonly protocol: string;
  readonly vendor: string | null;
  readonly baseUrl: string;
  readonly status: number;
  /** 记录面逻辑删除时刻（回收站）：null = 在册；非空 = 已删除 */
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
}

export type ProviderSortField = 'id' | 'name' | 'status' | 'createdAt';

/** 列表视图：active = 在册（缺省，含启用/禁用，不含已删除）；deleted = 回收站（仅已删除） */
export type ProviderListView = 'active' | 'deleted';

/** 管理面列表查询（统一列表形状 + 回收站视图） */
export type ProviderListQuery = ListQuery<ProviderSortField> & { readonly view?: ProviderListView };

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
  /** 仅在册（deleted_at IS NULL）；已删除记录不可见 = null */
  findById(db: DbLike, providerId: number): Promise<ProviderRecord | null>;
  /** 仅在册——已删除记录的名称视为可复用（目录/渠道导入按新记录处理） */
  findByName(db: DbLike, name: string): Promise<ProviderRecord | null>;
  /** 部分更新（仅白名单字段，仅在册行；0 行 = 不存在（含已删除）） */
  update(
    db: DbLike,
    input: { providerId: number; patch: ProviderPatchInput },
  ): Promise<ProviderRecord | null>;
  /** 禁用：status=1（仅在册行）；false = 不存在（含已删除） */
  retire(db: DbLike, input: { providerId: number }): Promise<boolean>;
  /**
   * 逻辑删除（回收站）：status=1 + deleted_at=now（仅在册行可删）。
   * 行数据与渠道 FK 引用保留可追溯；名称随部分唯一索引释放可复用。
   */
  softDelete(db: DbLike, input: { providerId: number }): Promise<boolean>;
  /** 恢复记录：deleted_at=NULL + status=1（回禁用态，不直接启用；仅已删除行） */
  restore(db: DbLike, input: { providerId: number }): Promise<boolean>;
  /** 统一列表：q 命中 name/baseUrl（字面匹配）；白名单排序 + id 决胜；view 缺省 = 在册 */
  list(db: DbLike, query: ProviderListQuery): Promise<ListResult<ProviderRecord>>;
}

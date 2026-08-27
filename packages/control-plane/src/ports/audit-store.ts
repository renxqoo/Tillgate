/**
 * AuditStore port：审计行的只读查询边界（价格溯源）。
 * 审计存储/查询/保留归 observability；当前由 adapters/postgres 承接。
 * 全局审计列表/定向查询是运维读侧，不在本包。
 */
import type { DbLike } from '@tillgate/db';

export interface AuditLogRow {
  readonly id: number;
  readonly adminId: number | null;
  readonly actor: string;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly detail: unknown;
  readonly createdAt: Date;
}

export interface AuditStore {
  /** 目录定价溯源：某对外名历次目录导入/改价的审计行（detail.models 含该名） */
  listCatalogPriceHistory(
    db: DbLike,
    input: { externalName: string; limit?: number },
  ): Promise<readonly AuditLogRow[]>;
}

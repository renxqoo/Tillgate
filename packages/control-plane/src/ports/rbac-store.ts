/**
 * 动态 RBAC store port：角色与权限树资源的读写边界（ADR-0008）。
 * 授权策略守卫（super 不可变/内置不可删/码唯一/enforced 锁）由 application 裁决——
 * port 不藏策略;SQL 只在 adapters/postgres。
 */
import type { DbLike } from '@tokenlens/db';

// ── 角色 ────────────────────────────────────────────────────────────────────

export interface RoleRecord {
  readonly id: number;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  /** 0 正常 / 1 停用（整角色 kill-switch） */
  readonly status: number;
  readonly isSuper: boolean;
  readonly isBuiltin: boolean;
  readonly createdAt: Date;
}

export interface RoleListQuery {
  readonly q?: string;
  readonly sortBy: 'id' | 'code' | 'createdAt';
  readonly order: 'asc' | 'desc';
  readonly limit: number;
  readonly offset: number;
}

export interface RoleListResult {
  readonly rows: (RoleRecord & { adminCount: number; codes: string[] })[];
  readonly total: number;
}

export interface CreateRoleRow {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly codes: readonly string[];
}

export interface UpdateRoleRow {
  readonly roleId: number;
  readonly name?: string;
  readonly description?: string | null;
  readonly status?: number;
  /** 全量替换授权（LWW;未传不动） */
  readonly codes?: readonly string[];
}

export interface RoleStore {
  list(db: DbLike, query: RoleListQuery): Promise<RoleListResult>;
  findById(db: DbLike, id: number): Promise<RoleRecord | null>;
  findByCode(db: DbLike, code: string): Promise<RoleRecord | null>;
  create(db: DbLike, row: CreateRoleRow): Promise<RoleRecord>;
  update(db: DbLike, row: UpdateRoleRow): Promise<RoleRecord | null>;
  remove(db: DbLike, roleId: number): Promise<void>;
  /** 角色当前授权码集合 */
  codesOf(db: DbLike, roleId: number): Promise<string[]>;
  /** 全量替换授权码（事务外调用方负责原子性;码 → permission id 逐条解析） */
  replaceCodes(db: DbLike, roleId: number, codes: readonly string[]): Promise<void>;
  /** 挂载管理员计数（删除守卫与列表展示） */
  adminCount(db: DbLike, roleId: number): Promise<number>;
}

// ── 权限树资源 ──────────────────────────────────────────────────────────────

export interface PermissionNode {
  readonly id: number;
  readonly parentId: number | null;
  readonly type: 'group' | 'page' | 'button';
  readonly code: string | null;
  readonly name: string;
  readonly i18nKey: string | null;
  readonly description: string | null;
  readonly path: string | null;
  readonly icon: string | null;
  readonly sortOrder: number;
  /** 0 正常 / 1 停用（kill-switch;enforced 不可停用） */
  readonly status: number;
  readonly source: 'enforced' | 'custom';
  readonly createdAt: Date;
}

export interface CreatePermissionRow {
  readonly parentId: number | null;
  readonly type: 'page' | 'button' | 'group';
  readonly code: string | null;
  readonly name: string;
  readonly i18nKey: string | null;
  readonly description: string | null;
  readonly path: string | null;
  readonly icon: string | null;
  readonly sortOrder: number;
}

export interface UpdatePermissionRow {
  readonly id: number;
  /** 展示字段（code/type/父子/source 一律不可改——enforced 锁与 code 即身份的统一面） */
  readonly name?: string;
  readonly i18nKey?: string | null;
  readonly description?: string | null;
  readonly icon?: string | null;
  readonly sortOrder?: number;
  /** 仅 custom 可停用;enforced 停用由 application 拒绝 */
  readonly status?: number;
}

export interface PermissionStore {
  /** 全量节点（管理面树;调用方自组树） */
  list(db: DbLike): Promise<PermissionNode[]>;
  findById(db: DbLike, id: number): Promise<PermissionNode | null>;
  /** code 已被占用?（全量唯一性应用层守卫——DB 部分索引只兜按钮） */
  codeTaken(db: DbLike, code: string): Promise<boolean>;
  create(db: DbLike, row: CreatePermissionRow): Promise<PermissionNode>;
  update(db: DbLike, row: UpdatePermissionRow): Promise<PermissionNode | null>;
  remove(db: DbLike, id: number): Promise<void>;
  /** 子节点计数（删除守卫） */
  childCount(db: DbLike, id: number): Promise<number>;
  /** 被角色绑定计数（删除守卫——绑定时删节点 = 静默撤权,必须拦） */
  bindingCount(db: DbLike, id: number): Promise<number>;
  /** 活动码集合（授权写入校验 + 启动对账消费） */
  activeCodes(db: DbLike): Promise<string[]>;
}

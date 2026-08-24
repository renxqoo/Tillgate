/**
 * 动态 RBAC postgres 适配器（ports/rbac-store 唯一实现）。
 * 时间戳一律 SQL now();role 授权替换 = 事务内 delete+insert（调用方开事务）。
 */
import { asc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { admins, endpointPermissions, permissions, rolePermissions, roles } from '@tillgate/db';
import type { DbLike } from '@tillgate/db';
import type {
  CreateEndpointRow,
  UpdateEndpointRow,
  CreatePermissionRow,
  CreateRoleRow,
  EndpointBindingRecord,
  EndpointStore,
  PermissionNode,
  PermissionStore,
  RoleListQuery,
  RoleListResult,
  RoleRecord,
  RoleStore,
  UpdatePermissionRow,
  UpdateRoleRow,
} from '../../ports/rbac-store';

/** LIKE 模式转义 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

const roleProjection = {
  id: roles.id,
  code: roles.code,
  name: roles.name,
  description: roles.description,
  status: roles.status,
  isSuper: roles.isSuper,
  isBuiltin: roles.isBuiltin,
  createdAt: roles.createdAt,
};

const nodeProjection = {
  id: permissions.id,
  parentId: permissions.parentId,
  type: permissions.type,
  code: permissions.code,
  name: permissions.name,
  i18nKey: permissions.i18nKey,
  description: permissions.description,
  path: permissions.path,
  icon: permissions.icon,
  sortOrder: permissions.sortOrder,
  status: permissions.status,
  source: permissions.source,
  createdAt: permissions.createdAt,
};

export const postgresRoleStore: RoleStore = {
  async list(db: DbLike, query: RoleListQuery): Promise<RoleListResult> {
    const filter =
      query.q != null && query.q !== '' ? ilike(roles.name, `%${escapeLike(query.q)}%`) : undefined;
    const sortColumns = { id: roles.id, code: roles.code, createdAt: roles.createdAt } as const;
    const sortColumn = sortColumns[query.sortBy];
    const rows = await db
      .select(roleProjection)
      .from(roles)
      .where(filter)
      .orderBy(query.order === 'desc' ? sql`${sortColumn} desc` : asc(sortColumn))
      .limit(query.limit)
      .offset(query.offset);
    const counted = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(roles)
      .where(filter);
    const ids = rows.map((row) => row.id);
    const grantsRows =
      ids.length === 0
        ? []
        : await db
            .select({ roleId: rolePermissions.roleId, code: permissions.code })
            .from(rolePermissions)
            .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
            .where(inArray(rolePermissions.roleId, ids));
    const adminCounts =
      ids.length === 0
        ? []
        : await db
            .select({ roleId: admins.roleId, count: sql<number>`count(*)::int` })
            .from(admins)
            .where(inArray(admins.roleId, ids))
            .groupBy(admins.roleId);
    const countMap = new Map(adminCounts.map((row) => [row.roleId, row.count]));
    return {
      rows: rows.map((row) => ({
        ...(row as RoleRecord),
        adminCount: countMap.get(row.id) ?? 0,
        codes: grantsRows
          .filter((grant) => grant.roleId === row.id && grant.code != null)
          .map((grant) => grant.code as string),
      })),
      total: counted[0]?.total ?? 0,
    };
  },

  async findById(db: DbLike, id: number): Promise<RoleRecord | null> {
    const rows = await db.select(roleProjection).from(roles).where(eq(roles.id, id)).limit(1);
    return (rows[0] as RoleRecord | undefined) ?? null;
  },

  async findByCode(db: DbLike, code: string): Promise<RoleRecord | null> {
    const rows = await db.select(roleProjection).from(roles).where(eq(roles.code, code)).limit(1);
    return (rows[0] as RoleRecord | undefined) ?? null;
  },

  async create(db: DbLike, row: CreateRoleRow): Promise<RoleRecord> {
    const inserted = await db
      .insert(roles)
      .values({ code: row.code, name: row.name, description: row.description })
      .returning(roleProjection);
    const record = inserted[0] as RoleRecord | undefined;
    if (record == null) throw new Error('insert roles returned no row');
    if (row.codes.length > 0) await this.replaceCodes(db, record.id, row.codes);
    return record;
  },

  async update(db: DbLike, row: UpdateRoleRow): Promise<RoleRecord | null> {
    const updated = await db
      .update(roles)
      .set({
        updatedAt: sql`now()`,
        ...(row.name !== undefined ? { name: row.name } : {}),
        ...(row.description !== undefined ? { description: row.description } : {}),
        ...(row.status !== undefined ? { status: row.status } : {}),
      })
      .where(eq(roles.id, row.roleId))
      .returning(roleProjection);
    return (updated[0] as RoleRecord | undefined) ?? null;
  },

  async remove(db: DbLike, roleId: number): Promise<void> {
    await db.delete(roles).where(eq(roles.id, roleId));
  },

  async codesOf(db: DbLike, roleId: number): Promise<string[]> {
    const rows = await db
      .select({ code: permissions.code })
      .from(rolePermissions)
      .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(eq(rolePermissions.roleId, roleId));
    return rows.map((row) => row.code).filter((code): code is string => code != null);
  },

  async replaceCodes(db: DbLike, roleId: number, codes: readonly string[]): Promise<void> {
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    if (codes.length === 0) return;
    const nodes = await db
      .select({ id: permissions.id, code: permissions.code })
      .from(permissions)
      .where(inArray(permissions.code, [...codes]));
    // 共享码（页面共用域读码）授全部同名节点——授 users:read 覆盖用户页+限流页;
    // 绑定按 id 解析活码,任一节点改名其授权面随之,零漂移语义完整
    const values = nodes
      .filter((node) => node.code != null && codes.includes(node.code))
      .map((node) => ({ roleId, permissionId: node.id }));
    if (values.length > 0) {
      await db.insert(rolePermissions).values(values).onConflictDoNothing();
    }
  },

  async adminCount(db: DbLike, roleId: number): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(admins)
      .where(eq(admins.roleId, roleId));
    return rows[0]?.count ?? 0;
  },
};

export const postgresPermissionStore: PermissionStore = {
  async list(db: DbLike): Promise<PermissionNode[]> {
    const rows = await db
      .select(nodeProjection)
      .from(permissions)
      .orderBy(asc(permissions.sortOrder), asc(permissions.id));
    return rows as PermissionNode[];
  },

  async findById(db: DbLike, id: number): Promise<PermissionNode | null> {
    const rows = await db
      .select(nodeProjection)
      .from(permissions)
      .where(eq(permissions.id, id))
      .limit(1);
    return (rows[0] as PermissionNode | undefined) ?? null;
  },

  async codeTaken(db: DbLike, code: string): Promise<boolean> {
    const rows = await db
      .select({ one: sql<number>`1` })
      .from(permissions)
      .where(eq(permissions.code, code))
      .limit(1);
    return rows.length > 0;
  },

  async create(db: DbLike, row: CreatePermissionRow): Promise<PermissionNode> {
    const inserted = await db
      .insert(permissions)
      .values({
        parentId: row.parentId,
        type: row.type,
        code: row.code,
        name: row.name,
        i18nKey: row.i18nKey,
        description: row.description,
        path: row.path,
        icon: row.icon,
        sortOrder: row.sortOrder,
      })
      .returning(nodeProjection);
    const node = inserted[0] as PermissionNode | undefined;
    if (node == null) throw new Error('insert permissions returned no row');
    return node;
  },

  async update(db: DbLike, row: UpdatePermissionRow): Promise<PermissionNode | null> {
    const updated = await db
      .update(permissions)
      .set({
        updatedAt: sql`now()`,
        ...(row.name !== undefined ? { name: row.name } : {}),
        ...(row.i18nKey !== undefined ? { i18nKey: row.i18nKey } : {}),
        ...(row.description !== undefined ? { description: row.description } : {}),
        ...(row.icon !== undefined ? { icon: row.icon } : {}),
        ...(row.path !== undefined ? { path: row.path } : {}),
        ...(row.sortOrder !== undefined ? { sortOrder: row.sortOrder } : {}),
        ...(row.status !== undefined ? { status: row.status } : {}),
        ...(row.code !== undefined ? { code: row.code } : {}),
        ...(row.type !== undefined ? { type: row.type } : {}),
        ...(row.parentId !== undefined ? { parentId: row.parentId } : {}),
        ...(row.source !== undefined ? { source: row.source } : {}),
      })
      .where(eq(permissions.id, row.id))
      .returning(nodeProjection);
    return (updated[0] as PermissionNode | undefined) ?? null;
  },

  async remove(db: DbLike, id: number): Promise<void> {
    await db.delete(permissions).where(eq(permissions.id, id));
  },

  async childCount(db: DbLike, id: number): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(permissions)
      .where(eq(permissions.parentId, id));
    return rows[0]?.count ?? 0;
  },

  async bindingCount(db: DbLike, id: number): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(rolePermissions)
      .where(eq(rolePermissions.permissionId, id));
    return rows[0]?.count ?? 0;
  },

  async activeCodes(db: DbLike): Promise<string[]> {
    // 活动码 = status 0（enforced 与 custom 同权——custom 码作用于角色绑定与显示层门控;
    // 启动对账的 enforced ⊆ 活动集检查不受影响:注册表码必然属于本集合的 enforced 子集）
    const rows = await db
      .select({ code: permissions.code })
      .from(permissions)
      .where(eq(permissions.status, 0));
    return rows.map((row) => row.code).filter((code): code is string => code != null);
  },
};

// ── 接口权限绑定 postgres 实现（ADR-0009）────────────────────────────────────

const endpointProjection = {
  id: endpointPermissions.id,
  method: endpointPermissions.method,
  path: endpointPermissions.path,
  permissionId: endpointPermissions.permissionId,
  source: endpointPermissions.source,
  createdAt: endpointPermissions.createdAt,
};

export const postgresEndpointStore: EndpointStore = {
  async list(db: DbLike): Promise<EndpointBindingRecord[]> {
    const rows = await db
      .select(endpointProjection)
      .from(endpointPermissions)
      .orderBy(asc(endpointPermissions.path), asc(endpointPermissions.method));
    return rows as EndpointBindingRecord[];
  },

  async create(db: DbLike, row: CreateEndpointRow): Promise<EndpointBindingRecord> {
    const inserted = await db
      .insert(endpointPermissions)
      .values({ method: row.method, path: row.path, permissionId: row.permissionId })
      .returning(endpointProjection);
    const record = inserted[0] as EndpointBindingRecord | undefined;
    if (record == null) throw new Error('insert endpoint_permissions returned no row');
    return record;
  },

  async update(
    db: DbLike,
    id: number,
    row: UpdateEndpointRow,
  ): Promise<EndpointBindingRecord | null> {
    const updated = await db
      .update(endpointPermissions)
      .set({
        ...(row.method !== undefined ? { method: row.method } : {}),
        ...(row.path !== undefined ? { path: row.path } : {}),
        ...(row.permissionId !== undefined ? { permissionId: row.permissionId } : {}),
      })
      .where(eq(endpointPermissions.id, id))
      .returning(endpointProjection);
    return (updated[0] as EndpointBindingRecord | undefined) ?? null;
  },

  async remove(db: DbLike, id: number): Promise<void> {
    await db.delete(endpointPermissions).where(eq(endpointPermissions.id, id));
  },

  async bindingCountOf(db: DbLike, permissionId: number): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(endpointPermissions)
      .where(eq(endpointPermissions.permissionId, permissionId));
    return rows[0]?.count ?? 0;
  },
};

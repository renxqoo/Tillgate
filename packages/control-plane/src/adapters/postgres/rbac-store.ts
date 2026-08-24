/**
 * RBAC v2 postgres 适配器（ports/rbac-store 唯一实现）。
 * 时间戳一律 SQL now();role 授权替换 = 事务内 delete+insert（调用方开事务）。
 */
import { and, asc, eq, ilike, inArray, sql } from 'drizzle-orm';
import { admins, permissions, rolePermissions, roles } from '@tokenlens/db';
import type { DbLike } from '@tokenlens/db';
import type {
  CreatePermissionRow,
  CreateRoleRow,
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
    const sortColumn =
      query.sortBy === 'code'
        ? roles.code
        : query.sortBy === 'createdAt'
          ? roles.createdAt
          : roles.id;
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
    const byCode = new Map(nodes.map((node) => [node.code as string, node.id]));
    const values = codes
      .map((code) => byCode.get(code))
      .filter((id): id is number => id != null)
      .map((permissionId) => ({ roleId, permissionId }));
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
        ...(row.sortOrder !== undefined ? { sortOrder: row.sortOrder } : {}),
        ...(row.status !== undefined ? { status: row.status } : {}),
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
    const rows = await db
      .select({ code: permissions.code })
      .from(permissions)
      .where(and(eq(permissions.status, 0), eq(permissions.source, 'enforced')));
    return rows.map((row) => row.code).filter((code): code is string => code != null);
  },
};

/**
 * 管理员资料 postgres 适配器（ports/admin-store 唯一实现）。
 * 时间戳一律 SQL now()（touchLastLogin/updatedAt）；投影不含密码/2FA 密钥列——
 * 凭据单一真相在 identity 七表（G1/G2 裁决,admins.password_hash 冻结只读不投影）。
 * 重名交给 admins_email_uq 唯一索引（23505 由 application 翻译冲突）。
 */
import { asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { admins } from '@tokenlens/db';
import type { DbLike, DbTx } from '@tokenlens/db';
import type {
  AdminListQuery,
  AdminListResult,
  AdminRecord,
  AdminStore,
  CreateAdminRow,
  UpdateAdminRow,
} from '../../ports/admin-store';

/** LIKE 模式转义（用户输入的 %/_ 按字面匹配） */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * 旧列 admins.password_hash 的占位值（NOT NULL 兜底）：凭据单一真相在 identity 七表，
 * HTTP 面创建的管理员从未有过 v1 密码——非 scrypt 形态哨兵值天然不可被旧校验路径误认。
 */
const IDENTITY_MANAGED_HASH = 'identity-managed';

/** admin id 段分配下限（2026-08-23 生产裁决）：identity_passwords.userId 是无 realm
 *  的扁平主键，admin id 与 users.id 同号即凭据串号——新管理员一律落 ≥1e9 段
 *  （与 apps/admin-api/scripts/create-admin.ts 同语义;段值两处同源,改动须同步）。 */
const ADMIN_ID_SEGMENT_FLOOR = 1_000_000_000;

const projection = {
  id: admins.id,
  email: admins.email,
  displayName: admins.displayName,
  status: admins.status,
  role: admins.role,
  twoFactorEnabled: admins.twoFactorEnabled,
  lastLoginAt: admins.lastLoginAt,
  createdAt: admins.createdAt,
};

export const postgresAdminStore: AdminStore = {
  async findById(db: DbLike, id: number): Promise<AdminRecord | null> {
    const rows = await db.select(projection).from(admins).where(eq(admins.id, id)).limit(1);
    return (rows[0] as AdminRecord | undefined) ?? null;
  },

  async findByEmail(db: DbLike, email: string): Promise<AdminRecord | null> {
    const rows = await db.select(projection).from(admins).where(eq(admins.email, email)).limit(1);
    return (rows[0] as AdminRecord | undefined) ?? null;
  },

  async touchLastLogin(db: DbLike, id: number): Promise<void> {
    await db
      .update(admins)
      .set({ lastLoginAt: sql`now()` })
      .where(eq(admins.id, id));
  },

  async setTwoFactorEnabled(db: DbLike, input: { adminId: number; enabled: boolean }) {
    await db
      .update(admins)
      .set({ twoFactorEnabled: input.enabled, updatedAt: sql`now()` })
      .where(eq(admins.id, input.adminId));
  },

  async list(db: DbLike, query: AdminListQuery): Promise<AdminListResult> {
    const filter =
      query.q != null && query.q !== ''
        ? or(
            ilike(admins.email, `%${escapeLike(query.q)}%`),
            ilike(admins.displayName, `%${escapeLike(query.q)}%`),
          )
        : undefined;
    const sortColumn =
      query.sortBy === 'email'
        ? admins.email
        : query.sortBy === 'lastLoginAt'
          ? admins.lastLoginAt
          : query.sortBy === 'createdAt'
            ? admins.createdAt
            : admins.id;
    const rows = await db
      .select(projection)
      .from(admins)
      .where(filter)
      .orderBy(query.order === 'desc' ? desc(sortColumn) : asc(sortColumn))
      .limit(query.limit)
      .offset(query.offset);
    const counted = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(admins)
      .where(filter);
    return { rows: rows as AdminRecord[], total: counted[0]?.total ?? 0 };
  },

  async create(db: DbTx, row: CreateAdminRow): Promise<AdminRecord> {
    // id ≥1e9 段分配（max+1 兜底新库从 1 起步的序列;插显式 id 后同步推高序列）
    const [maxRow] = await db
      .select({ maxId: sql<number>`coalesce(max(${admins.id}), 0)::bigint` })
      .from(admins);
    const id = Math.max(ADMIN_ID_SEGMENT_FLOOR, Number(maxRow?.maxId ?? 0) + 1);
    const inserted = await db
      .insert(admins)
      .values({
        id,
        email: row.email,
        displayName: row.displayName,
        role: row.role,
        passwordHash: IDENTITY_MANAGED_HASH,
      })
      .returning(projection);
    await db.execute(sql`select setval(pg_get_serial_sequence('admins', 'id'), ${id})`);
    const record = inserted[0] as AdminRecord | undefined;
    if (record == null) {
      throw new Error('insert admins returned no row');
    }
    return record;
  },

  async update(db: DbLike, row: UpdateAdminRow): Promise<AdminRecord | null> {
    const updated = await db
      .update(admins)
      .set({
        updatedAt: sql`now()`,
        ...(row.displayName !== undefined ? { displayName: row.displayName } : {}),
        ...(row.role !== undefined ? { role: row.role } : {}),
        ...(row.status !== undefined ? { status: row.status } : {}),
      })
      .where(eq(admins.id, row.adminId))
      .returning(projection);
    return (updated[0] as AdminRecord | undefined) ?? null;
  },

  async remove(db: DbLike, adminId: number): Promise<void> {
    await db.delete(admins).where(eq(admins.id, adminId));
  },
};
